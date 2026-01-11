/**
 * Indexing Route
 * Start chapter indexing job
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { queues, QUEUE_NAMES, IndexingJobData } from '../lib/queue.js';
import { createJobEventStream } from '../sse/event-stream.js';
import { parseJsonField } from '../lib/json-utils.js';

const StartIndexingSchema = z.object({
    model: z.string().optional(),
});

export async function indexingRoutes(app: FastifyInstance): Promise<void> {
    // Start indexing job
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/index',
        async (request, reply) => {
            const { id } = request.params;
            const body = StartIndexingSchema.parse(request.body ?? {});

            // Check session exists and has chapters
            const session = await prisma.session.findUnique({
                where: { id },
                select: { id: true, chapters: true, status: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const chapters = parseJsonField<Record<string, unknown>>(session.chapters, {});
            if (Object.keys(chapters).length === 0) {
                return reply.status(400).send({ error: 'No chapters to index' });
            }

            // Create task record
            const task = await prisma.task.create({
                data: {
                    sessionId: id,
                    type: 'indexing',
                    status: 'pending',
                    total: Object.keys(chapters).length,
                },
            });

            // Add job to queue
            const jobData: IndexingJobData = {
                sessionId: id,
                taskId: task.id,
                model: body.model,
            };

            const job = await queues.indexing.add(QUEUE_NAMES.INDEXING, jobData, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
            });

            // Update task with job ID
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

    // Get indexing status
    app.get<{ Params: { id: string } }>(
        '/api/sessions/:id/index/status',
        async (request, reply) => {
            const { id } = request.params;

            const task = await prisma.task.findFirst({
                where: { sessionId: id, type: 'indexing' },
                orderBy: { createdAt: 'desc' },
                include: {
                    events: {
                        orderBy: { createdAt: 'desc' },
                        take: 10,
                    },
                },
            });

            if (!task) {
                return reply.status(404).send({ error: 'No indexing task found' });
            }

            return {
                taskId: task.id,
                status: task.status,
                progress: task.progress,
                total: task.total,
                error: task.error,
                events: task.events,
            };
        }
    );

    // SSE endpoint for indexing events
    app.get<{ Params: { taskId: string } }>(
        '/api/tasks/:taskId/events',
        async (request, reply) => {
            await createJobEventStream(request, reply);
        }
    );
}
