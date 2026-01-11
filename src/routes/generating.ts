/**
 * Generating Route
 * Start node generation job
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { queues, QUEUE_NAMES, GeneratingJobData } from '../lib/queue.js';
import { parseJsonField } from '../lib/json-utils.js';

const StartGeneratingSchema = z.object({
    model: z.string().optional(),
    nodeId: z.number().optional(), // Regenerate specific node
    startFromNode: z.number().optional(), // Resume from node
    autoReview: z.boolean().optional(), // Enable auto review loop
});

export async function generatingRoutes(app: FastifyInstance): Promise<void> {
    // Start generation job
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/generate',
        async (request, reply) => {
            const { id } = request.params;
            const body = StartGeneratingSchema.parse(request.body ?? {});

            // Check session is confirmed
            const session = await prisma.session.findUnique({
                where: { id },
                select: { id: true, planConfirmed: true, nodes: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            if (!session.planConfirmed) {
                return reply.status(400).send({ error: 'Plan must be confirmed first' });
            }

            const nodes = parseJsonField<Record<string, unknown>>(session.nodes, {});
            if (Object.keys(nodes).length === 0) {
                return reply.status(400).send({ error: 'No nodes to generate' });
            }

            // Create task
            const task = await prisma.task.create({
                data: {
                    sessionId: id,
                    type: 'generating',
                    status: 'pending',
                    total: body.nodeId ? 1 : Object.keys(nodes).length,
                },
            });

            // Add job to queue
            const jobData: GeneratingJobData = {
                sessionId: id,
                taskId: task.id,
                nodeId: body.nodeId,
                startFromNode: body.startFromNode,
                model: body.model,
                autoReview: body.autoReview,
            };

            const job = await queues.generating.add(QUEUE_NAMES.GENERATING, jobData, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            });

            await prisma.task.update({
                where: { id: task.id },
                data: { bullJobId: job.id },
            });

            // Update session status
            await prisma.session.update({
                where: { id },
                data: { status: 'executing' },
            });

            return {
                taskId: task.id,
                jobId: job.id,
                status: 'pending',
            };
        }
    );

    // Get generation status
    app.get<{ Params: { id: string } }>(
        '/api/sessions/:id/generate/status',
        async (request, reply) => {
            const { id } = request.params;

            const task = await prisma.task.findFirst({
                where: { sessionId: id, type: 'generating' },
                orderBy: { createdAt: 'desc' },
                include: {
                    events: {
                        orderBy: { createdAt: 'desc' },
                        take: 20,
                    },
                },
            });

            if (!task) {
                return reply.status(404).send({ error: 'No generating task found' });
            }

            // Get current nodes status
            const session = await prisma.session.findUnique({
                where: { id },
                select: { nodes: true },
            });

            const nodes = session ? parseJsonField<Record<string, any>>(session.nodes, {}) : {};
            const nodeStatuses = Object.values(nodes).map((n: any) => ({
                id: n.id,
                status: n.status,
                hasContent: !!n.content,
            }));

            return {
                taskId: task.id,
                status: task.status,
                progress: task.progress,
                total: task.total,
                error: task.error,
                events: task.events,
                nodeStatuses,
            };
        }
    );

    // Cancel generation
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/generate/cancel',
        async (request, reply) => {
            const { id } = request.params;

            const task = await prisma.task.findFirst({
                where: {
                    sessionId: id,
                    type: 'generating',
                    status: { in: ['pending', 'running'] },
                },
                orderBy: { createdAt: 'desc' },
            });

            if (!task || !task.bullJobId) {
                return reply.status(404).send({ error: 'No active generating task found' });
            }

            // Remove job from queue
            const job = await queues.generating.getJob(task.bullJobId);
            if (job) {
                await job.remove();
            }

            // Update task status
            await prisma.task.update({
                where: { id: task.id },
                data: { status: 'cancelled' },
            });

            return { success: true, taskId: task.id };
        }
    );
}
