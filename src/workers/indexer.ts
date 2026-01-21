/**
 * Indexer Worker
 * Process chapter indexing jobs
 */
import { Job } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { publishEvent, channels } from '../lib/redis.js';
import { chatWithRetry, getModel, MODEL_ROUTER, TOKEN_LIMITS } from '../lib/llm.js';
import { getCharacterMapPrompt, getIndexingPrompt, createTrace } from '../lib/langfuse.js';
import { tryParseJson, parseJsonField, parseJsonLoose } from '../lib/json-utils.js';
import { IndexingResponseSchema } from '../schemas/llm-responses.js';
import { IndexingJobData } from '../lib/queue.js';
import { Chapter, ChapterIndex } from '../schemas/session.js';
import { config } from '../config/index.js';

export async function processIndexingJob(job: Job<IndexingJobData>): Promise<void> {
    const { sessionId, taskId, model } = job.data;
    const channel = channels.jobEvents(taskId);

    console.log(`\n📚 [Indexer] Starting job for session: ${sessionId.slice(0, 8)}...`);
    console.log(`   Task: ${taskId}, Model: ${model ?? getModel(MODEL_ROUTER.indexer)}`);

    // Get session data
    const session = await prisma.session.findUnique({
        where: { id: sessionId },
    });

    if (!session) {
        throw new Error('Session not found');
    }

    const chapters = parseJsonField<Record<string, Chapter>>(session.chapters, {});
    const chapterList = Object.values(chapters).sort((a, b) => a.number - b.number);

    // 会话级角色改名总开关（从 contentAnalysis.remapCharacters 读取，默认 true）
    const contentAnalysisExisting = parseJsonField<Record<string, any>>(
        (session as any).contentAnalysis ?? {},
        {},
    );
    const remapCharactersEnabled = !!contentAnalysisExisting.remapCharacters;

    // Clear previous raw character logs for this session to avoid duplication
    if (remapCharactersEnabled) {
        await prisma.rawCharacterLog.deleteMany({ where: { sessionId } });
    }
    const total = chapterList.length;

    // Update task status
    await prisma.task.update({
        where: { id: taskId },
        data: { status: 'running', total },
    });

    await publishEvent(channel, {
        type: 'progress',
        message: `Starting indexing of ${total} chapters...`,
        data: { progress: 0, total },
    });

    const chapterIndex: ChapterIndex[] = [];
    const resolvedModel = model ?? getModel(MODEL_ROUTER.indexer);

    console.log(`📖 [Indexer] Processing ${total} chapters in batches of 5...`);

    // Process chapters in parallel batches
    const batchSize = 5;
    for (let i = 0; i < chapterList.length; i += batchSize) {
        const batch = chapterList.slice(i, i + batchSize);

        const results = await Promise.all(
            batch.map(async (chapter) => {
                try {
                    // Generate prompt from Langfuse
                    const prompt = await getIndexingPrompt({
                        chapterNumber: chapter.number,
                        chapterTitle: chapter.title,
                        chapterContent: chapter.content.slice(0, 6000), // Limit content length
                        language: config.novelLanguage as 'cn' | 'en',
                    });

                    // Call LLM
                    const response = await chatWithRetry(prompt, {
                        model: resolvedModel,
                        maxTokens: TOKEN_LIMITS.indexer,
                    });

                    // Best-effort: extract raw characters for later consolidation
                    if (remapCharactersEnabled) {
                        try {
                            const loose = parseJsonLoose(response);
                            const rawChars = extractRawCharacters(loose);
                            if (rawChars.length > 0) {
                                await prisma.rawCharacterLog.createMany({
                                    data: rawChars.map((c) => ({
                                        sessionId,
                                        chapterNumber: chapter.number,
                                        name: c.name,
                                        role: c.role ?? null,
                                        aliases: c.aliases ?? undefined,
                                    })),
                                });
                            }
                        } catch (e) {
                            console.warn(`[Indexer] Failed to extract raw characters for chapter ${chapter.number}:`, e);
                        }
                    }

                    // Parse response
                    const result = tryParseJson(response, IndexingResponseSchema);

                    if (result.success) {
                        return {
                            number: chapter.number,
                            title: chapter.title,
                            summary: result.data.summary,
                            characters: result.data.characters as string[],
                            keyEvent: result.data.key_event,
                            type: result.data.type as 'highlight' | 'normal',
                        } satisfies ChapterIndex;
                    } else {
                        // Fallback for parse errors
                        console.warn(`Failed to parse index for chapter ${chapter.number}:`, result.error);
                        return {
                            number: chapter.number,
                            title: chapter.title,
                            summary: chapter.content.slice(0, 200) + '...',
                            characters: [],
                            keyEvent: 'Unable to extract',
                            type: 'normal' as const,
                        } satisfies ChapterIndex;
                    }
                } catch (error) {
                    console.error(`Error indexing chapter ${chapter.number}:`, error);
                    return {
                        number: chapter.number,
                        title: chapter.title,
                        summary: 'Error during indexing',
                        characters: [],
                        keyEvent: 'Error',
                        type: 'normal' as const,
                    } satisfies ChapterIndex;
                }
            })
        );

        chapterIndex.push(...results);

        // Update progress
        const progress = Math.floor((chapterIndex.length / total) * 100);
        await prisma.task.update({
            where: { id: taskId },
            data: { progress },
        });

        await publishEvent(channel, {
            type: 'progress',
            message: `Indexed ${chapterIndex.length}/${total} chapters`,
            data: { progress, total, current: chapterIndex.length },
        });

        // Log batch completion
        await publishEvent(channel, {
            type: 'log',
            message: `Completed batch: chapters ${batch[0].number} - ${batch[batch.length - 1].number}`,
        });
    }

    // Sort by chapter number
    chapterIndex.sort((a, b) => a.number - b.number);

    // Analyze content for mode recommendation
    const avgLength = chapterList.reduce((sum, c) => sum + c.content.length, 0) / total;
    const contentAnalysis = {
        totalChapters: total,
        avgChapterLength: Math.round(avgLength),
        recommendedMode: avgLength > 8000 ? 'split' : avgLength < 3000 && total > 30 ? 'merge' : 'normal',
        targetNodeCount: Math.round(total * (avgLength > 8000 ? 2 : avgLength < 3000 ? 0.25 : 1)),
    };

    // Save to database
    await prisma.session.update({
        where: { id: sessionId },
        data: {
            // Store as native JSON values
            chapterIndex,
            contentAnalysis,
            status: 'planning',
        },
    });

    // Build global character map after indexing is done (single LLM call)
    if (remapCharactersEnabled) {
        try {
            await buildCharacterMapForSession(sessionId, channel);
        } catch (e) {
            console.warn(`[Indexer] Failed to build character map for session ${sessionId}:`, e);
        }
    }

    // Complete task
    await prisma.task.update({
        where: { id: taskId },
        data: {
            status: 'completed',
            progress: 100,
            result: { indexedCount: chapterIndex.length, analysis: contentAnalysis },
        },
    });

    await publishEvent(channel, {
        type: 'complete',
        message: `Indexing complete! ${chapterIndex.length} chapters indexed.`,
        data: { indexedCount: chapterIndex.length, analysis: contentAnalysis },
    });

    console.log(`✅ [Indexer] Complete! ${chapterIndex.length} chapters indexed.`);
    console.log(`   Recommended mode: ${contentAnalysis.recommendedMode}, Target nodes: ${contentAnalysis.targetNodeCount}\n`);
}

// Extract rich character objects from loose parsed LLM output
function extractRawCharacters(loose: any): Array<{ name: string; role?: string; aliases?: string[] }> {
    const rawList = loose?.characters;
    if (!Array.isArray(rawList)) return [];

    const result: Array<{ name: string; role?: string; aliases?: string[] }> = [];
    for (const entry of rawList) {
        if (!entry) continue;
        if (typeof entry === 'string') {
            result.push({ name: entry });
        } else if (typeof entry === 'object') {
            const name = typeof entry.name === 'string' ? entry.name : '';
            if (!name) continue;
            const role = typeof entry.role === 'string' ? entry.role : undefined;
            const aliases = Array.isArray(entry.aliases)
                ? entry.aliases.filter((a: unknown) => typeof a === 'string')
                : undefined;
            result.push({ name, role, aliases });
        }
    }
    return result;
}

// Build and store characterMap on Session using RawCharacterLog and a single LLM call
// Optionally publishes a preview of the mapping to the indexing task SSE channel
async function buildCharacterMapForSession(sessionId: string, sseChannel?: string): Promise<void> {
    const raw = await prisma.rawCharacterLog.findMany({
        where: { sessionId },
    });

    if (!raw.length) return;

    // Aggregate by name
    const byName = new Map<string, {
        name: string;
        count: number;
        roles: Set<string>;
        aliases: Set<string>;
    }>();

    for (const row of raw) {
        const key = row.name;
        if (!byName.has(key)) {
            byName.set(key, {
                name: row.name,
                count: 0,
                roles: new Set<string>(),
                aliases: new Set<string>(),
            });
        }
        const agg = byName.get(key)!;
        agg.count += 1;
        if (row.role) agg.roles.add(row.role);
        if (Array.isArray(row.aliases)) {
            for (const a of row.aliases as any[]) {
                if (typeof a === 'string') agg.aliases.add(a);
            }
        }
    }

    const payload = Array.from(byName.values()).map((item) => ({
        name: item.name,
        count: item.count,
        roles: Array.from(item.roles),
        aliases: Array.from(item.aliases),
    }));

    const charactersJson = JSON.stringify(payload, null, 2);

    const prompt = await getCharacterMapPrompt({
        charactersJson,
    });

    const { tryParseJson } = await import('../lib/json-utils.js');
    const { z } = await import('zod');
    const schema = z.record(z.string());

    const response = await chatWithRetry(prompt, {
        model: getModel(MODEL_ROUTER.indexer),
        maxTokens: 1024,
    });

    const parsed = tryParseJson(response, schema as any);
    if (!parsed.success) {
        console.warn('[Indexer] Failed to parse characterMap JSON from LLM');
        return;
    }

    await prisma.session.update({
        where: { id: sessionId },
        data: {
            // validated by Zod schema above; cast is safe for Prisma JSON field
            characterMap: parsed.data as any,
        },
    });

    // Optionally emit a preview of the character map so users can see
    // what renames will be applied.
    if (sseChannel) {
        const entries = Object.entries(parsed.data as Record<string, string>);
        if (entries.length > 0) {
            const previewPairs = entries.slice(0, 20);
            const previewText = previewPairs
                .map(([from, to]) => `${from} -> ${to}`)
                .join('\n');

            await publishEvent(sseChannel, {
                type: 'log',
                message: '[Indexer] Character map built. Example mappings:\n' + previewText,
                data: {
                    characterMapPreview: Object.fromEntries(previewPairs),
                    totalMappings: entries.length,
                },
            });
        }
    }
}
