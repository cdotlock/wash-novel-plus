/**
 * Planning Route
 * Generate and manage event plans
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { queues, QUEUE_NAMES, PlanningJobData } from '../lib/queue.js';
import { EventPlanSchema, PlanningModeSchema, EventPlan } from '../schemas/plan.js';
import { parseJsonField } from '../lib/json-utils.js';
import { ChapterIndex } from '../schemas/session.js';
import { getModel, MODEL_ROUTER, TOKEN_LIMITS, chatWithRetry } from '../lib/llm.js';
import { getPlanningButterflyPrompt } from '../lib/langfuse.js';

const GeneratePlanSchema = z.object({
    mode: PlanningModeSchema.optional(),
    targetNodeCount: z.number().optional(),
    customInstructions: z.string().optional(),
    model: z.string().optional(),
});

const UpdatePlanSchema = z.object({
    events: z.array(EventPlanSchema).optional(),
    confirmed: z.boolean().optional(),
});

// Butterfly-effect micro-tuning schema: based on current (possibly edited) events
const AdjustPlanSchema = z.object({
    mode: PlanningModeSchema.optional(),
    targetNodeCount: z.number(),
    events: z.array(EventPlanSchema),
    model: z.string().optional(),
});

export async function planningRoutes(app: FastifyInstance): Promise<void> {
    // Generate plan
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/plan',
        async (request, reply) => {
            const { id } = request.params;
            const body = GeneratePlanSchema.parse(request.body ?? {});

            // Log planning request for debugging / observability
            request.log.warn({
                sessionId: id,
                mode: body.mode ?? 'auto',
                targetNodeCount: body.targetNodeCount ?? null,
            }, 'Starting planning task');

            // Check session has chapter index
            const session = await prisma.session.findUnique({
                where: { id },
                select: { id: true, chapterIndex: true, status: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const chapterIndex = parseJsonField(session.chapterIndex, [] as unknown[]);
            if (!Array.isArray(chapterIndex) || chapterIndex.length === 0) {
                return reply.status(400).send({ error: 'Session must be indexed first' });
            }

            // Prevent concurrent planning for the same session
            const activePlanning = await prisma.task.findFirst({
                where: {
                    sessionId: id,
                    type: 'planning',
                    status: { in: ['pending', 'running'] },
                },
            });

            if (activePlanning) {
                return reply.status(400).send({ error: 'Planning already in progress for this session' });
            }

            // Create task
            const task = await prisma.task.create({
                data: {
                    sessionId: id,
                    type: 'planning',
                    status: 'pending',
                },
            });

            // Add job to queue
            const jobData: PlanningJobData = {
                sessionId: id,
                taskId: task.id,
                mode: body.mode,
                targetNodeCount: body.targetNodeCount,
                model: body.model,
            };

            const job = await queues.planning.add(QUEUE_NAMES.PLANNING, jobData);

            await prisma.task.update({
                where: { id: task.id },
                data: { bullJobId: job.id },
            });

            return {
                taskId: task.id,
                jobId: job.id,
                status: 'pending',
            };
        }
    );

    // Get current plan
    app.get<{ Params: { id: string } }>(
        '/api/sessions/:id/plan',
        async (request, reply) => {
            const { id } = request.params;

            const session = await prisma.session.findUnique({
                where: { id },
                select: {
                    planEvents: true,
                    planRationale: true,
                    planMode: true,
                    planConfirmed: true,
                    contentAnalysis: true,
                },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const rawEvents = session.planEvents as unknown;
            const rawAnalysis = session.contentAnalysis as unknown;

            let events: unknown = [];
            let analysis: unknown = {};

            try {
                if (typeof rawEvents === 'string') {
                    events = rawEvents ? JSON.parse(rawEvents) : [];
                } else if (Array.isArray(rawEvents)) {
                    events = rawEvents;
                }
            } catch (e) {
                app.log.error({ err: e }, 'Failed to parse planEvents JSON');
                events = [];
            }

            try {
                if (typeof rawAnalysis === 'string') {
                    analysis = rawAnalysis ? JSON.parse(rawAnalysis) : {};
                } else if (rawAnalysis && typeof rawAnalysis === 'object') {
                    analysis = rawAnalysis;
                }
            } catch (e) {
                app.log.error({ err: e }, 'Failed to parse contentAnalysis JSON');
                analysis = {};
            }

            return {
                events,
                rationale: session.planRationale,
                mode: session.planMode,
                confirmed: session.planConfirmed,
                analysis,
            };
        }
    );

    // Update plan (modify events or confirm)
    app.patch<{ Params: { id: string } }>(
        '/api/sessions/:id/plan',
        async (request, reply) => {
            const { id } = request.params;
            const body = UpdatePlanSchema.parse(request.body);

            const session = await prisma.session.findUnique({
                where: { id },
                select: { planEvents: true, planConfirmed: true, nodes: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            // If already confirmed, cannot modify
            if (session.planConfirmed && !body.confirmed) {
                return reply.status(400).send({ error: 'Plan already confirmed' });
            }

            const updateData: Record<string, unknown> = {};

            // Update events if provided
            if (body.events) {
                updateData.planEvents = body.events;
            }

            // Confirm plan and initialize nodes
            if (body.confirmed) {
                const storedEvents = session.planEvents as unknown;
                const events = body.events
                    ?? (typeof storedEvents === 'string'
                        ? JSON.parse(storedEvents)
                        : Array.isArray(storedEvents)
                            ? storedEvents
                            : []);

                // Create nodes from events (JSON view for existing pipeline)
                const nodes: Record<string, unknown> = {};
                for (const event of events) {
                    nodes[event.id] = {
                        id: event.id,
                        type: event.type,
                        startChapter: event.startChapter,
                        endChapter: event.endChapter,
                        description: event.description,
                        content: '',
                        status: 'pending',
                        createdAt: new Date().toISOString(),
                    };
                }

                updateData.planConfirmed = true;
                updateData.nodes = nodes;
                updateData.status = 'confirmed';

                // Use transaction to ensure atomic confirmation
                await prisma.$transaction(async (tx) => {
                    // Reset existing main nodes and recreate
                    await tx.node.deleteMany({ where: { sessionId: id, type: 'main' } });
                    await tx.node.createMany({
                        data: events.map((event: any) => ({
                            sessionId: id,
                            type: 'main',
                            nodeIndex: event.id,
                            title: String(event.description ?? '').slice(0, 50),
                            description: String(event.description ?? ''),
                            content: '',
                            startChapter: event.startChapter ?? null,
                            endChapter: event.endChapter ?? null,
                            parentId: null,
                            returnToNodeId: null,
                            branchReason: null,
                            status: 'pending',
                            qualityScore: null,
                        })),
                    });

                    await tx.session.update({
                        where: { id },
                        data: updateData,
                    });
                });

                return { success: true, confirmed: true };
            }

            await prisma.session.update({
                where: { id },
                data: updateData,
            });

            return { success: true, confirmed: body.confirmed ?? false };
        }
    );

    // Adjust existing plan with butterfly-effect micro-tuning
    // This is a synchronous endpoint (no background task) that takes the
    // current edited events, applies a second-pass planning prompt, and
    // returns updated events/rationale.
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/plan/adjust',
        async (request, reply) => {
            const { id } = request.params;
            const body = AdjustPlanSchema.parse(request.body ?? {});

            const session = await prisma.session.findUnique({
                where: { id },
                select: { chapterIndex: true, contentAnalysis: true, planMode: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const chapterIndex = parseJsonField<ChapterIndex[]>(session.chapterIndex, []);
            if (!Array.isArray(chapterIndex) || chapterIndex.length === 0) {
                return reply.status(400).send({ error: 'Session must be indexed first' });
            }

            const totalChapters = chapterIndex.length;
            const firstChapter = chapterIndex[0].number;
            const lastChapter = chapterIndex[chapterIndex.length - 1].number;

            // Build chapter summaries text (reuse initial planning format)
            const chapterSummaries = chapterIndex
                .map((c) => `Chapter ${c.number}: ${c.title}\n  Summary: ${c.summary}\n  Type: ${c.type}\n  Key Event: ${c.keyEvent}`)
                .join('\n\n');

            const resolvedMode = body.mode ?? (session.planMode as any) ?? 'auto';
            const resolvedModel = body.model ?? getModel(MODEL_ROUTER.planner);

            // Prepare planning-adjust prompt
            const prompt = await getPlanningButterflyPrompt({
                mode: resolvedMode === 'one_to_one' ? 'auto' : (resolvedMode as 'auto' | 'split' | 'merge'),
                chapterSummaries,
                currentEvents: JSON.stringify(body.events, null, 2),
                targetNodeCount: body.targetNodeCount,
            });

            try {
                const response = await chatWithRetry(prompt, {
                    model: resolvedModel,
                    maxTokens: TOKEN_LIMITS.planner,
                });

                // First try strict JSON parsing against LLMPlanningResponseSchema.
                // If that fails (model output not exactly matching schema), fall back
                // to a looser JSON repair/parse so that reasonable outputs still work.
                const { tryParseJson, parseJsonLoose } = await import('../lib/json-utils.js');
                const { LLMPlanningResponseSchema } = await import('../schemas/llm-responses.js');

                let raw: any;
                let rawEventsArray: any[] = [];
                let rationale: string | undefined;

                const parsed = tryParseJson(response, LLMPlanningResponseSchema as any);

                if (parsed.success) {
                    raw = parsed.data as any;
                    rawEventsArray = Array.isArray(raw)
                        ? raw
                        : Array.isArray(raw.events)
                            ? raw.events
                            : [];
                    rationale = Array.isArray(raw) ? undefined : raw.rationale;
                } else {
                    // Fallback: best-effort loose JSON parse (handles extra wrappers, minor format issues).
                    try {
                        const loose = parseJsonLoose(response);
                        if (Array.isArray(loose)) {
                            rawEventsArray = loose;
                            rationale = undefined;
                        } else if (loose && Array.isArray((loose as any).events)) {
                            rawEventsArray = (loose as any).events;
                            rationale = (loose as any).rationale;
                        } else {
                            app.log.error({ err: parsed.error, loose }, 'Failed to parse planning adjust response (loose parse)');
                            return reply.status(500).send({ error: 'Failed to parse planning adjust response' });
                        }
                    } catch (e) {
                        app.log.error({ err: e }, 'Failed to parse planning adjust response (jsonrepair)');
                        return reply.status(500).send({ error: 'Failed to parse planning adjust response' });
                    }
                }

                // Normalize to EventPlan
                const normalizedEvents = rawEventsArray.map((ev, idx) => {
                    const start = Number(ev.start_chapter ?? ev.startChapter ?? ev.start);
                    const end = Number(ev.end_chapter ?? ev.endChapter ?? ev.end ?? start);
                    const safeStart = Number.isFinite(start) && start >= firstChapter ? start : firstChapter;
                    const safeEnd = Number.isFinite(end) && end >= safeStart ? end : safeStart;

                    return {
                        id: idx + 1,
                        type: (String(ev.type || 'normal').toLowerCase().includes('highlight')
                            ? 'highlight'
                            : 'normal') as 'highlight' | 'normal',
                        startChapter: safeStart,
                        endChapter: safeEnd,
                        description: String(ev.description ?? '').trim() || `Chapter ${safeStart}-${safeEnd}`,
                        sceneCount: Number.isFinite(ev.scene_count) ? Number(ev.scene_count) : 1,
                    } as EventPlan;
                });

                // Clamp coverage to chapter index range in case of out-of-bound values
                const clampedEvents = normalizedEvents.map((e) => ({
                    ...e,
                    startChapter: Math.max(firstChapter, Math.min(e.startChapter, lastChapter)),
                    endChapter: Math.max(firstChapter, Math.min(e.endChapter, lastChapter)),
                }));

                // Update session with adjusted plan (but do NOT auto-confirm)
                const contentAnalysis = parseJsonField<any>(session.contentAnalysis, {});
                const updatedAnalysis = {
                    ...contentAnalysis,
                    lastPlanEventCount: clampedEvents.length,
                    lastPlanUserTarget: body.targetNodeCount ?? null,
                };

                await prisma.session.update({
                    where: { id },
                    data: {
                        planEvents: clampedEvents,
                        planRationale: rationale ?? '',
                        contentAnalysis: updatedAnalysis,
                    },
                });

                return {
                    events: clampedEvents,
                    rationale: rationale ?? '',
                    analysis: updatedAnalysis,
                };
            } catch (error) {
                app.log.error({ err: error }, 'Planning adjust failed');
                return reply.status(500).send({ error: 'Planning adjust failed' });
            }
        },
    );
}
