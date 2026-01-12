/**
 * Planner Worker
 * Process event planning jobs
 */
import { Job } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { publishEvent, channels } from '../lib/redis.js';
import { chatWithRetry, getModel, MODEL_ROUTER, TOKEN_LIMITS } from '../lib/llm.js';
import { parseJsonField, parseJsonLoose } from '../lib/json-utils.js';
import { PlanningJobData } from '../lib/queue.js';
import { ChapterIndex } from '../schemas/session.js';
import { EventPlan } from '../schemas/plan.js';
import { getPlanningPrompt } from '../lib/langfuse.js';

export async function processPlanningJob(job: Job<PlanningJobData>): Promise<void> {
    const { sessionId, taskId, mode, targetNodeCount, model } = job.data;
    const channel = channels.jobEvents(taskId);

    try {
        // Get session data
        const session = await prisma.session.findUnique({
            where: { id: sessionId },
        });

        if (!session) {
            throw new Error('Session not found');
        }

        const chapterIndex = parseJsonField<ChapterIndex[]>(session.chapterIndex, []);
        if (chapterIndex.length === 0) {
            throw new Error('No chapter index found');
        }

        const totalChapters = chapterIndex.length;
        const firstChapter = chapterIndex[0].number;
        const lastChapter = chapterIndex[chapterIndex.length - 1].number;
        const contentAnalysis = parseJsonField<any>(session.contentAnalysis, {});
        const recommendedTarget = typeof contentAnalysis.targetNodeCount === 'number'
            ? contentAnalysis.targetNodeCount
            : Math.round(totalChapters * 0.8);

        // Determine mode & model early so we can log them
        const resolvedMode = mode ?? 'auto';
        const resolvedModel = model ?? getModel(MODEL_ROUTER.planner);
        const effectiveTargetNodeCount = targetNodeCount ?? recommendedTarget;

        // Update task status
        await prisma.task.update({
            where: { id: taskId },
            data: { status: 'running' },
        });

        await publishEvent(channel, {
            type: 'thought',
            message: `[Planner] Dispatching planning job via queue \"planning\" (mode=${resolvedMode}, target=${targetNodeCount ?? 'auto'}, model=${resolvedModel})`,
            data: {
                worker: 'planner',
                queue: 'planning',
                mode: resolvedMode,
                userTargetNodeCount: targetNodeCount ?? null,
                effectiveTargetNodeCount,
                model: resolvedModel,
            },
        });

        await publishEvent(channel, {
            type: 'progress',
            message: 'Starting event planning...',
            data: { progress: 0 },
        });

        // Build chapter summaries text
        const chapterSummaries = chapterIndex
            .map((c) => `Chapter ${c.number}: ${c.title}\n  Summary: ${c.summary}\n  Type: ${c.type}\n  Key Event: ${c.keyEvent}`)
            .join('\n\n');

        // Determine mode
        // (already computed above before logging)

        let events: EventPlan[];
        let rationale = '';

        if (resolvedMode === 'one_to_one') {
            // One-to-One Mode: Deterministic mapping from index
            await publishEvent(channel, {
                type: 'thought',
                message: 'One-to-One Mode active: Mapping chapters directly to event nodes...',
            });

            events = chapterIndex.map((chapter, index) => ({
                id: index + 1,
                type: chapter.type,
                startChapter: chapter.number,
                endChapter: chapter.number,
                description: chapter.summary,
                sceneCount: 1,
            }));

            rationale = 'One-to-one mapping requested by user.';
        } else {
            // AI Planning Modes (Auto, Split, Merge)

            // Generate planning prompt via Langfuse
            const prompt = await getPlanningPrompt({
                mode: resolvedMode,
                chapterSummaries,
                // 如果用户没有填，就把索引阶段推荐的节点数传给提示，以提高稳定性
                targetNodeCount: effectiveTargetNodeCount,
                customInstructions: (job.data as any).customInstructions,
            });

            await publishEvent(channel, {
                type: 'thought',
                message: 'Analyzing chapter structure and designing event nodes...',
            });

            // Call LLM
            const response = await chatWithRetry(prompt, {
                model: resolvedModel,
                maxTokens: TOKEN_LIMITS.planner,
            });

            await publishEvent(channel, {
                type: 'progress',
                message: 'Parsing planning response...',
                data: { progress: 50 },
            });

            // Primary path: loose JSON parse + heuristic extraction
            try {
                const parsed = parseJsonLoose(response);
                const extracted = extractPlanningEvents(parsed);

                if (!extracted || !Array.isArray(extracted.events)) {
                    throw new Error('No events found in planning response');
                }

                events = normalizePlanningEvents(extracted.events, chapterIndex);
                rationale = extracted.rationale ?? '';
            } catch (primaryError) {
                // Attempt more aggressive repair before giving up
                const repaired = await repairPlanningResponse(response, resolvedModel);

                if (!repaired || !Array.isArray(repaired.events) || repaired.events.length === 0) {
                    console.error('Failed to parse planning response after repair attempts:', primaryError);
                    throw new Error('Failed to parse planning response after repair attempts');
                }

                events = normalizePlanningEvents(repaired.events, chapterIndex);
                rationale = repaired.rationale ?? '';
            }

            // NOTE: We intentionally no longer perform automatic post-processing
            // like merging consecutive highlights or auto-filling chapter gaps.
            // The LLM prompt is responsible for producing a topology that matches
            // the user's expectations, and users can edit ranges directly in the UI.
        }

        // Merge simple stats into contentAnalysis so frontend can display them
        const updatedAnalysis = {
            ...contentAnalysis,
            lastPlanEventCount: events.length,
            lastPlanUserTarget: targetNodeCount ?? null,
        };

        // Save to database
        await prisma.session.update({
            where: { id: sessionId },
            data: {
                // Store as native JSON (Prisma Json)
                planEvents: events,
                planRationale: rationale,
                planMode: resolvedMode,
                status: 'planning',
                contentAnalysis: updatedAnalysis,
            },
        });

        // Complete task
        await prisma.task.update({
            where: { id: taskId },
            data: {
                status: 'completed',
                progress: 100,
                result: { eventCount: events.length, rationale },
            },
        });

        await publishEvent(channel, {
            type: 'complete',
            message: `Planning complete! Generated ${events.length} event nodes.`,
            data: { eventCount: events.length, events },
        });
    } catch (error) {
        console.error(`Error in planning job for session ${sessionId}:`, error);

        // Persist error to task and emit SSE error event so UI can react
        try {
            await prisma.task.update({
                where: { id: taskId },
                data: {
                    status: 'failed',
                    error: String(error),
                },
            });
        } catch (taskError) {
            console.error('Failed to update task with planning error:', taskError);
        }

        await publishEvent(channel, {
            type: 'error',
            message: `Planning failed: ${error instanceof Error ? error.message : String(error)}`,
            data: { error: String(error) },
        });

        // Re-throw so BullMQ can apply its retry strategy
        throw error;
    }
}

// Repair planning response JSON using local heuristics and optional LLM-based repair
async function repairPlanningResponse(
    raw: string,
    model: string,
): Promise<{ events: any[]; rationale?: string } | null> {
    // First try loose JSON parsing + heuristic extraction
    try {
        const loose = parseJsonLoose(raw);
        const extracted = extractPlanningEvents(loose);
        if (extracted && Array.isArray(extracted.events)) {
            return extracted;
        }
    } catch (e) {
        console.error('Loose planning JSON parse failed:', e);
    }

    // As a last resort, ask the LLM itself to repair the JSON
    try {
        const repairPrompt = [
            {
                role: 'system',
                content:
                    'You are a strict JSON repair engine. Given noisy text that is supposed to be a planning response, you must output ONLY valid JSON. No explanations, no markdown, just JSON.',
            },
            {
                role: 'user',
                content: `Repair the following LLM output into valid planning JSON and return ONLY the JSON object:\n\n${raw}`,
            },
        ] as any[];

        const repairedText = await chatWithRetry(repairPrompt, {
            model,
            maxTokens: TOKEN_LIMITS.planner,
        });

        try {
            const repairedParsed = parseJsonLoose(repairedText);
            const extracted = extractPlanningEvents(repairedParsed);
            if (extracted && Array.isArray(extracted.events)) {
                return extracted;
            }
        } catch (e) {
            console.error('LLM-based planning repair JSON parse failed:', e);
        }
    } catch (e) {
        console.error('LLM-based planning repair failed:', e);
    }

    return null;
}

// Extract events / rationale from arbitrary parsed JSON
function extractPlanningEvents(parsed: any): { events: any[]; rationale?: string } | null {
    if (!parsed) return null;

    // Case 1: root is array of events
    if (Array.isArray(parsed)) {
        return { events: parsed, rationale: '' };
    }

    // Case 2: root has events field
    if ((parsed as any).events) {
        const ev = (parsed as any).events;
        if (Array.isArray(ev)) {
            return { events: ev, rationale: (parsed as any).rationale };
        }
        // Single object -> wrap as array
        if (typeof ev === 'object') {
            return { events: [ev], rationale: (parsed as any).rationale };
        }
    }

    // Case 3: some providers wrap payload in data/result
    const container = (parsed as any).data ?? (parsed as any).result ?? null;
    if (container) {
        if (Array.isArray(container)) {
            return { events: container, rationale: (container as any).rationale };
        }
        if ((container as any).events) {
            const ev = (container as any).events;
            if (Array.isArray(ev)) {
                return { events: ev, rationale: (container as any).rationale };
            }
            if (typeof ev === 'object') {
                return { events: [ev], rationale: (container as any).rationale };
            }
        }
    }

    return null;
}

// Normalize raw planning events from LLM into EventPlan objects
function normalizePlanningEvents(rawEvents: any[], chapterIndex: ChapterIndex[]): EventPlan[] {
    const events: EventPlan[] = [];

    const firstChapter = chapterIndex[0]?.number ?? 1;
    const lastChapter = chapterIndex[chapterIndex.length - 1]?.number ?? firstChapter;

    rawEvents.forEach((raw, idx) => {
        if (!raw || typeof raw !== 'object') return;

        // Normalize type
        let type: 'highlight' | 'normal' = 'normal';
        if (typeof raw.type === 'string') {
            const t = raw.type.toLowerCase();
            if (t.includes('highlight') || t.includes('高光')) {
                type = 'highlight';
            } else {
                type = 'normal';
            }
        }

        // Normalize chapter range
        const start = Number(
            raw.start_chapter ?? raw.startChapter ?? raw.start ?? raw.start_index,
        );
        const end = Number(
            raw.end_chapter ?? raw.endChapter ?? raw.end ?? raw.end_index,
        );

        const safeStart = Number.isFinite(start) && start >= firstChapter ? start : firstChapter;
        const safeEnd = Number.isFinite(end) && end >= safeStart ? end : safeStart;

        // Normalize description
        const description = String(raw.description ?? raw.desc ?? '').trim() ||
            `Chapter ${safeStart}-${safeEnd} (${type})`;

        const sceneCount = Number.isFinite(raw.scene_count)
            ? Number(raw.scene_count)
            : 1;

        events.push({
            id: typeof raw.id === 'number' ? raw.id : idx + 1,
            type,
            startChapter: safeStart,
            endChapter: safeEnd,
            description,
            sceneCount,
        });
    });

    // Ensure IDs are sequential
    return events
        .sort((a, b) => a.startChapter - b.startChapter)
        .map((e, i) => ({ ...e, id: i + 1 }));
}

// Merge consecutive highlight events
function mergeConsecutiveHighlights(events: EventPlan[]): EventPlan[] {
    const result: EventPlan[] = [];

    for (const event of events) {
        const last = result[result.length - 1];

        if (last && last.type === 'highlight' && event.type === 'highlight') {
            // Merge into previous
            last.endChapter = event.endChapter;
            last.description = `${last.description} + ${event.description}`;
        } else {
            result.push({ ...event });
        }
    }

    // Re-number IDs
    return result.map((e, i) => ({ ...e, id: i + 1 }));
}

// Validate chapter coverage
function validateCoverage(events: EventPlan[], startChapter: number, endChapter: number): EventPlan[] {
    // Sort by start chapter
    events.sort((a, b) => a.startChapter - b.startChapter);

    // Fill gaps
    const result: EventPlan[] = [];
    let currentChapter = startChapter;
    let nextId = 1;

    for (const event of events) {
        // Fill gap if exists
        if (event.startChapter > currentChapter) {
            result.push({
                id: nextId++,
                type: 'normal',
                startChapter: currentChapter,
                endChapter: event.startChapter - 1,
                description: 'Transition segment',
                sceneCount: 1,
            });
        }

        result.push({ ...event, id: nextId++ });
        currentChapter = event.endChapter + 1;
    }

    // Fill end gap
    if (currentChapter <= endChapter) {
        result.push({
            id: nextId,
            type: 'normal',
            startChapter: currentChapter,
            endChapter: endChapter,
            description: 'Final segment',
            sceneCount: 1,
        });
    }

    return result;
}

/** End of planner helpers */
