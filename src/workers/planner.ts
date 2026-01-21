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
import { config } from '../config/index.js';

export async function processPlanningJob(job: Job<PlanningJobData>): Promise<void> {
    const { sessionId, taskId, mode, targetNodeCount, model } = job.data;
    const channel = channels.jobEvents(taskId);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📝 [Planner] Starting job for session: ${sessionId.slice(0, 8)}...`);
    console.log(`   Mode: ${mode ?? 'auto'}, Target: ${targetNodeCount ?? 'auto'}, Model: ${model ?? getModel(MODEL_ROUTER.planner)}`);
    console.log(`${'='.repeat(60)}`);

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

        // DEBUG: Log chapter index details
        console.log(`\n📊 [Planner DEBUG] Chapter Index Info:`);
        console.log(`   Total chapters in index: ${totalChapters}`);
        console.log(`   Chapter range: ${firstChapter} - ${lastChapter}`);
        console.log(`   First 3 chapters: ${chapterIndex.slice(0, 3).map(c => `${c.number}:${c.title?.slice(0, 20)}`).join(', ')}`);
        console.log(`   Last 3 chapters: ${chapterIndex.slice(-3).map(c => `${c.number}:${c.title?.slice(0, 20)}`).join(', ')}`);
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
            // AI Planning Modes (Auto, Split, Merge) with batch processing and robust retry

            const CHAPTERS_PER_BATCH = 50;
            const MIN_BATCH_SIZE = 10; // Don't split smaller than this

            // Helper: Split array into chunks
            function chunkArray<T>(arr: T[], size: number): T[][] {
                const chunks: T[][] = [];
                for (let i = 0; i < arr.length; i += size) {
                    chunks.push(arr.slice(i, i + size));
                }
                return chunks;
            }

            // Helper: Find chapters in index that are not covered by events
            function findMissingChapters(events: EventPlan[], chapters: ChapterIndex[]): number[] {
                const coveredChapters = new Set<number>();
                events.forEach(e => {
                    for (let i = e.startChapter; i <= e.endChapter; i++) {
                        coveredChapters.add(i);
                    }
                });
                return chapters.map(c => c.number).filter(n => !coveredChapters.has(n));
            }

            // Recursive planner with auto-split
            async function planBatchRecursive(
                batchChapters: ChapterIndex[],
                depth: number = 0,
            ): Promise<EventPlan[]> {
                const batchFirstChapter = batchChapters[0].number;
                const batchLastChapter = batchChapters[batchChapters.length - 1].number;
                const indent = '  '.repeat(depth);

                console.log(`${indent}📦 [Planner] Planning chapters ${batchFirstChapter}-${batchLastChapter} (${batchChapters.length} chapters)`);

                // Calculate proportional target node count
                const batchTargetNodes = Math.max(1, Math.round(effectiveTargetNodeCount * (batchChapters.length / totalChapters)));

                // Build chapter summaries
                const batchSummaries = batchChapters
                    .map((c) => `Chapter ${c.number}: ${c.title}\n  Summary: ${c.summary}\n  Type: ${c.type}\n  Key Event: ${c.keyEvent}`)
                    .join('\n\n');

                await publishEvent(channel, {
                    type: 'thought',
                    message: `Analyzing chapters ${batchFirstChapter}-${batchLastChapter} (${batchChapters.length} chapters, target ${batchTargetNodes} nodes)...`,
                });

                try {
                    // Generate prompt and call LLM
                    const prompt = await getPlanningPrompt({
                        mode: resolvedMode as 'auto' | 'split' | 'merge',
                        chapterSummaries: batchSummaries,
                        targetNodeCount: batchTargetNodes,
                        customInstructions: (job.data as any).customInstructions,
                        language: config.novelLanguage as 'cn' | 'en',
                    });

                    const response = await chatWithRetry(prompt, {
                        model: resolvedModel,
                        maxTokens: TOKEN_LIMITS.planner,
                    });

                    console.log(`${indent}📥 Response: ${response.length} chars`);

                    // Try to parse
                    let extracted: { events: any[]; rationale?: string } | null = null;
                    try {
                        const parsed = parseJsonLoose(response);
                        extracted = extractPlanningEvents(parsed);
                    } catch (parseError) {
                        console.warn(`${indent}   Parse failed, trying repair...`);
                        extracted = await repairPlanningResponse(response, resolvedModel);
                    }

                    if (!extracted || !Array.isArray(extracted.events) || extracted.events.length === 0) {
                        throw new Error('No events parsed');
                    }

                    // Normalize and check coverage
                    const batchEvents = normalizePlanningEvents(extracted.events, batchChapters);
                    const missingChapters = findMissingChapters(batchEvents, batchChapters);

                    console.log(`${indent}📋 Got ${batchEvents.length} events, ${missingChapters.length} missing`);

                    // If coverage is good enough, return
                    // 允许少量未覆盖（≤ 20%），其余情况交给递归拆分或后续补丁逻辑处理，避免无限重试。
                    if (missingChapters.length <= batchChapters.length * 0.2) {
                        await publishEvent(channel, {
                            type: 'thought',
                            message: `Chapters ${batchFirstChapter}-${batchLastChapter}: ${batchEvents.length} events ✓`,
                        });
                        return batchEvents;
                    }

                    // Too many missing - need to split if possible
                    throw new Error(`Too many missing chapters: ${missingChapters.length}`);

                } catch (error) {
                    // Can we split further?
                    if (batchChapters.length > MIN_BATCH_SIZE) {
                        const halfSize = Math.ceil(batchChapters.length / 2);
                        console.log(`${indent}⚠️ Splitting into 2 sub-batches of ~${halfSize} chapters...`);

                        await publishEvent(channel, {
                            type: 'thought',
                            message: `Splitting chapters ${batchFirstChapter}-${batchLastChapter} into smaller batches...`,
                        });

                        const subBatches = chunkArray(batchChapters, halfSize);
                        const subResults = await Promise.all(
                            subBatches.map(sub => planBatchRecursive(sub, depth + 1))
                        );
                        return subResults.flat();
                    } else {
                        // Can't split further, throw
                        console.error(`${indent}❌ Cannot split further, batch too small`);
                        throw error;
                    }
                }
            }

            // Main planning logic - use recursive planner with auto-split
            await publishEvent(channel, {
                type: 'thought',
                message: `Planning ${totalChapters} chapters...`,
            });

            // Start with initial batches, each will auto-split if needed
            if (totalChapters <= CHAPTERS_PER_BATCH) {
                // Single batch
                events = await planBatchRecursive(chapterIndex, 0);
                rationale = '';
            } else {
                // Multiple batches - process concurrently
                const batches = chunkArray(chapterIndex, CHAPTERS_PER_BATCH);
                console.log(`\n📦 [Planner] Splitting ${totalChapters} chapters into ${batches.length} batches...`);

                await publishEvent(channel, {
                    type: 'progress',
                    message: `Planning ${batches.length} batches concurrently...`,
                    data: { progress: 10 },
                });

                // Run all batches in parallel - each auto-splits if needed
                const batchResults = await Promise.all(
                    batches.map(batch => planBatchRecursive(batch, 0))
                );

                // Merge and re-number all events
                events = batchResults
                    .flat()
                    .sort((a, b) => a.startChapter - b.startChapter)
                    .map((e, idx) => ({ ...e, id: idx + 1 }));
                rationale = '';

                console.log(`\n✅ [Planner] All batches completed. Total events: ${events.length}`);
            }

            // Final validation + 补丁：对「真实存在但未被任何事件覆盖」的章节进行自动补全，并提示用户。
            const beforePatchMissing = findMissingChapters(events, chapterIndex);
            if (beforePatchMissing.length > 0) {
                console.warn(
                    `⚠️ [Planner] Detected ${beforePatchMissing.length} uncovered chapters before patch: ${beforePatchMissing.join(', ')}`,
                );
                await publishEvent(channel, {
                    type: 'thought',
                    message:
                        `检测到未被任何事件覆盖的章节：${beforePatchMissing.join(
                            ', ',
                        )}，将自动生成普通过渡事件（Transition segment），建议后续人工检查。`,
                    data: { missingChapters: beforePatchMissing },
                });

                // 针对缺失章节编号（这些编号一定来自 chapterIndex，而非「章节号数字上的空洞」），
                // 按连续区间补出若干普通事件，避免引用不存在的章节内容。
                const sortedMissing = [...beforePatchMissing].sort((a, b) => a - b);
                const patchEvents: EventPlan[] = [];

                let rangeStart = sortedMissing[0];
                let prev = sortedMissing[0];
                for (let i = 1; i < sortedMissing.length; i++) {
                    const curr = sortedMissing[i];
                    if (curr === prev + 1) {
                        prev = curr;
                        continue;
                    }
                    patchEvents.push({
                        id: 0, // 先占位，稍后整体重新编号
                        type: 'normal',
                        startChapter: rangeStart,
                        endChapter: prev,
                        description: 'Transition segment (auto-patch for uncovered chapters)',
                        sceneCount: 1,
                    });
                    rangeStart = curr;
                    prev = curr;
                }
                // 最后一段
                patchEvents.push({
                    id: 0,
                    type: 'normal',
                    startChapter: rangeStart,
                    endChapter: prev,
                    description: 'Transition segment (auto-patch for uncovered chapters)',
                    sceneCount: 1,
                });

                // 合并补丁事件并整体按章节排序、重新编号
                events = [...events, ...patchEvents]
                    .sort((a, b) => a.startChapter - b.startChapter)
                    .map((e, idx) => ({ ...e, id: idx + 1 }));
            }

            const finalMissing = findMissingChapters(events, chapterIndex);
            if (finalMissing.length > 0) {
                console.warn(`⚠️ [Planner] Final: ${finalMissing.length} chapters not fully covered after patch`);
                await publishEvent(channel, {
                    type: 'thought',
                    message: `警告：即使自动补全后，仍有 ${finalMissing.length} 章可能未被覆盖：${finalMissing.join(', ')}`,
                    data: { missingChapters: finalMissing },
                });
            } else {
                console.log(`✅ [Planner] All ${totalChapters} chapters covered by ${events.length} events (after patch if needed)`);
            }

            await publishEvent(channel, {
                type: 'progress',
                message: `Planning complete: ${events.length} events generated`,
                data: { progress: 90 },
            });
        }

        // DEBUG: Final summary before saving
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 [Planner DEBUG] FINAL SUMMARY:`);
        console.log(`   Input chapters: ${totalChapters} (range: ${firstChapter}-${lastChapter})`);
        console.log(`   Output events: ${events.length}`);
        if (events.length > 0) {
            const coveredChapters = new Set<number>();
            events.forEach(e => {
                for (let i = e.startChapter; i <= e.endChapter; i++) coveredChapters.add(i);
            });
            console.log(`   Chapters covered by final events: ${coveredChapters.size}`);
            console.log(`   Coverage range: ${Math.min(...coveredChapters)}-${Math.max(...coveredChapters)}`);

            const missingFinal: number[] = [];
            for (let i = firstChapter; i <= lastChapter; i++) {
                if (!coveredChapters.has(i)) missingFinal.push(i);
            }
            if (missingFinal.length > 0) {
                console.warn(`   ⚠️ FINAL MISSING CHAPTERS: ${missingFinal.join(', ')}`);
            } else {
                console.log(`   ✅ All chapters covered in final output!`);
            }
        }
        console.log(`${'='.repeat(60)}\n`);

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

        // 记录真实存在的章节编号（有的小说文本本身会缺失部分章节号，需要与「数字连续性」区分开来）
        const chapterNumbers = chapterIndex
            .map((c) => c.number)
            .filter((n) => Number.isFinite(n))
            .sort((a, b) => a - b);

        // 检测源文本中的「章节号缺失」，例如有 1,2,5,6 但没有 3,4 —— 这种情况不算规划缺失，
        // 只是源数据本身不完整，需要单独向前端/用户提示。
        const missingNumberRanges: Array<{ start: number; end: number }> = [];
        for (let i = 1; i < chapterNumbers.length; i++) {
            const prev = chapterNumbers[i - 1];
            const curr = chapterNumbers[i];
            if (curr > prev + 1) {
                missingNumberRanges.push({ start: prev + 1, end: curr - 1 });
            }
        }

        if (missingNumberRanges.length > 0) {
            const rangesText = missingNumberRanges
                .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
                .join(', ');

            console.warn(
                `⚠️ [Planner] Detected gaps in chapter numbering (source text missing chapters): ${rangesText}`,
            );
        }

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
