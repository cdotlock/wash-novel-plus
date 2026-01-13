/**
 * Indexer Worker
 * Process chapter indexing jobs
 */
import { Job } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { publishEvent, channels } from '../lib/redis.js';
import { chatWithRetry, getModel, MODEL_ROUTER, TOKEN_LIMITS } from '../lib/llm.js';
import { getIndexingPrompt, createTrace } from '../lib/langfuse.js';
import { tryParseJson, parseJsonField } from '../lib/json-utils.js';
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

                    // Parse response
                    const result = tryParseJson(response, IndexingResponseSchema);

                    if (result.success) {
                        return {
                            number: chapter.number,
                            title: chapter.title,
                            summary: result.data.summary,
                            characters: result.data.characters,
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
