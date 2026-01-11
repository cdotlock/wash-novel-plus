/**
 * Review Routes
 * Trigger batch review of generated nodes
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { queues, QUEUE_NAMES, ReviewingJobData } from '../lib/queue.js';
import { parseJsonField } from '../lib/json-utils.js';
import { Node } from '../schemas/node.js';

const StartReviewSchema = z.object({
    autoFix: z.boolean().optional(),
});

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
    // Start batch review job
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/review',
        async (request, reply) => {
            const { id } = request.params;
            const body = StartReviewSchema.parse(request.body ?? {});

            const session = await prisma.session.findUnique({
                where: { id },
                select: { nodes: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const nodes = parseJsonField<Record<string, Node>>(session.nodes, {});
            const completedNodes = Object.values(nodes).filter(
                (n) => n.status === 'completed' && !!n.content,
            );

            if (completedNodes.length === 0) {
                return reply.status(400).send({ error: 'No completed nodes to review' });
            }

            // Create task record
            const task = await prisma.task.create({
                data: {
                    sessionId: id,
                    type: 'reviewing',
                    status: 'pending',
                    total: completedNodes.length,
                },
            });

            const jobData: ReviewingJobData = {
                sessionId: id,
                taskId: task.id,
                autoFix: body.autoFix ?? true,
            } as ReviewingJobData;

            const job = await queues.reviewing.add(QUEUE_NAMES.REVIEWING, jobData, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            });

            await prisma.task.update({
                where: { id: task.id },
                data: { bullJobId: job.id },
            });

            return {
                taskId: task.id,
                jobId: job.id,
                status: 'pending',
            };
        },
    );
}
