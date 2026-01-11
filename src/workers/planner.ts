/**
 * Planner Worker
 * Process event planning jobs
 */
import { Job } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { publishEvent, channels } from '../lib/redis.js';
import { chatWithRetry, getModel, MODEL_ROUTER, TOKEN_LIMITS } from '../lib/llm.js';
import { tryParseJson, parseJsonField, parseJsonLoose } from '../lib/json-utils.js';
import { LLMPlanningResponseSchema } from '../schemas/llm-responses.js';
import { PlanningJobData } from '../lib/queue.js';
import { ChapterIndex } from '../schemas/session.js';
import { EventPlan } from '../schemas/plan.js';
import { getPlanningPrompt, getPlanningAdjustPrompt } from '../lib/langfuse.js';

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

            // Parse response with strict schema first
            const strictResult = tryParseJson(response, LLMPlanningResponseSchema);

            if (strictResult.success) {
                const raw = strictResult.data as any;
                const rawEvents = Array.isArray(raw) ? raw : raw.events;
                events = normalizePlanningEvents(rawEvents, chapterIndex);
                rationale = Array.isArray(raw) ? '' : raw.rationale ?? '';
            } else {
                // Second chance: loose JSON parsing + coercion
                try {
                    const raw = parseJsonLoose(response);
                    const rawEvents = Array.isArray(raw)
                        ? raw
                        : Array.isArray((raw as any).events)
                            ? (raw as any).events
                            : [];

                    if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
                        throw new Error('No events array found in planning response');
                    }

                    events = normalizePlanningEvents(rawEvents, chapterIndex);
                    rationale = typeof (raw as any).rationale === 'string' ? (raw as any).rationale : '';
                } catch (e) {
                    console.error('Failed to parse planning response even with loose parser:', e);
                    // Final fallback: single linear node to avoid total failure
                    events = [{
                        id: 1,
                        type: 'normal',
                        startChapter: firstChapter,
                        endChapter: lastChapter,
                        description: 'Complete story arc (fallback linear plan)',
                        sceneCount: 1,
                    }];
                    rationale = 'Fallback plan due to parsing error';
                }
            }

            // Post-process: merge consecutive highlights (only in AI modes)
            events = mergeConsecutiveHighlights(events);

            // Validate coverage and fill gaps
            events = validateCoverage(events, firstChapter, lastChapter);

            // 如果有目标节点数且当前数量不符，优先通过 LLM 做二次调整
            if (Number.isFinite(effectiveTargetNodeCount) && (effectiveTargetNodeCount as number) > 0) {
                const target = Math.max(1, Math.floor(effectiveTargetNodeCount as number));

                if (events.length !== target) {
                    try {
                        const adjustPrompt = await getPlanningAdjustPrompt({
                            mode: resolvedMode,
                            chapterSummaries,
                            currentEvents: events,
                            targetNodeCount: target,
                        });

                        await publishEvent(channel, {
                            type: 'thought',
                            message: `[Planner] 调整规划以匹配目标节点数: 当前 ${events.length}, 目标 ${target}（通过 LLM 二次规划）`,
                        });

                        const adjustResponse = await chatWithRetry(adjustPrompt, {
                            model: resolvedModel,
                            maxTokens: TOKEN_LIMITS.planner,
                        });

                        const strictAdjust = tryParseJson(adjustResponse, LLMPlanningResponseSchema);

                        if (strictAdjust.success) {
                            const raw = strictAdjust.data as any;
                            const rawEventsAdj = Array.isArray(raw) ? raw : raw.events;
                            const adjusted = normalizePlanningEvents(rawEventsAdj, chapterIndex);
                            if (adjusted.length > 0) {
                                events = validateCoverage(mergeConsecutiveHighlights(adjusted), firstChapter, lastChapter);
                            }
                        } else {
                            // 再尝试宽松解析
                            try {
                                const raw = parseJsonLoose(adjustResponse);
                                const rawEventsAdj = Array.isArray(raw)
                                    ? raw
                                    : Array.isArray((raw as any).events)
                                        ? (raw as any).events
                                        : [];
                                if (Array.isArray(rawEventsAdj) && rawEventsAdj.length > 0) {
                                    const adjusted = normalizePlanningEvents(rawEventsAdj, chapterIndex);
                                    events = validateCoverage(mergeConsecutiveHighlights(adjusted), firstChapter, lastChapter);
                                }
                            } catch (e) {
                                console.error('Planning adjust parse failed, fallback to heuristic enforcement:', e);
                            }
                        }
                    } catch (e) {
                        console.error('Planning adjust LLM call failed, fallback to heuristic enforcement:', e);
                    }

                    // 若 LLM 调整后仍与目标差距较大，作为兜底再用一次本地启发式合并/拆分
                    if (events.length !== target) {
                        events = enforceTargetNodeCount(
                            events,
                            firstChapter,
                            lastChapter,
                            target,
                        );
                    }

                    await publishEvent(channel, {
                        type: 'thought',
                        message: `Post-processed plan to ${events.length} nodes (target ≈ ${effectiveTargetNodeCount}).`,
                    });
                }
            }
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

/**
 * Adjust events to better match a target node count while keeping chapter coverage.
 *
 * - If we have too many events: iteratively merge the closest neighbouring events.
 * - If we have too few events: split the longest spans.
 *
 * This is intentionally simple and deterministic – the goal is to be stable,
 * not perfectly optimal.
 */
function enforceTargetNodeCount(
    events: EventPlan[],
    startChapter: number,
    endChapter: number,
    target: number,
): EventPlan[] {
    const cleanedTarget = Math.max(1, Math.floor(target));
    if (!Number.isFinite(cleanedTarget)) {
        return events;
    }

    if (events.length === 0) {
        return [{
            id: 1,
            type: 'normal',
            startChapter,
            endChapter,
            description: 'Complete story arc',
            sceneCount: 1,
        }];
    }

    let result = [...events].sort((a, b) => a.startChapter - b.startChapter);

    // Too many events: merge neighbouring events with the smallest combined span first
    while (result.length > cleanedTarget && result.length > 1) {
        let bestIndex = -1;
        let bestSpan = Number.POSITIVE_INFINITY;

        for (let i = 0; i < result.length - 1; i++) {
            const a = result[i];
            const b = result[i + 1];
            const span = b.endChapter - a.startChapter + 1;
            if (span < bestSpan) {
                bestSpan = span;
                bestIndex = i;
            }
        }

        if (bestIndex === -1) break;

        const a = result[bestIndex];
        const b = result[bestIndex + 1];
        const merged: EventPlan = {
            id: a.id,
            type: a.type === 'highlight' || b.type === 'highlight' ? 'highlight' : 'normal',
            startChapter: a.startChapter,
            endChapter: b.endChapter,
            description: `${a.description} / ${b.description}`,
            sceneCount: (a.sceneCount ?? 1) + (b.sceneCount ?? 1),
        };

        result.splice(bestIndex, 2, merged);
    }

    // Too few events: split the longest multi-chapter spans
    while (result.length < cleanedTarget) {
        let bestIndex = -1;
        let bestLength = 0;

        for (let i = 0; i < result.length; i++) {
            const e = result[i];
            const length = e.endChapter - e.startChapter + 1;
            if (length > bestLength && length >= 2) {
                bestLength = length;
                bestIndex = i;
            }
        }

        if (bestIndex === -1) {
            // Nothing left that can be split safely
            break;
        }

        const e = result[bestIndex];
        const mid = Math.floor((e.startChapter + e.endChapter) / 2);
        if (mid <= e.startChapter) break;

        const first: EventPlan = {
            ...e,
            endChapter: mid,
            description: `${e.description} (上半)`,
        };

        const second: EventPlan = {
            ...e,
            startChapter: mid + 1,
            description: `${e.description} (下半)`,
        };

        result.splice(bestIndex, 1, first, second);
    }

    // Clamp to overall chapter bounds and drop invalid ranges
    result = result
        .map((e) => ({
            ...e,
            startChapter: Math.max(startChapter, e.startChapter),
            endChapter: Math.min(endChapter, e.endChapter),
        }))
        .filter((e) => e.startChapter <= e.endChapter)
        .sort((a, b) => a.startChapter - b.startChapter);

    // Re-number IDs sequentially
    return result.map((e, i) => ({ ...e, id: i + 1 }));
}
