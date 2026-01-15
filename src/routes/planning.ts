/**
 * Planning Route
 * Generate and manage event plans
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { queues, QUEUE_NAMES, PlanningJobData } from '../lib/queue.js';
import { EventPlanSchema, PlanningModeSchema } from '../schemas/plan.js';
import { parseJsonField } from '../lib/json-utils.js';

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

                // Create nodes from events
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
                // Store nodes as native JSON record
                updateData.nodes = nodes;
                updateData.status = 'confirmed';
            }

            await prisma.session.update({
                where: { id },
                data: updateData,
            });

            return { success: true, confirmed: body.confirmed ?? false };
        }
    );
}
