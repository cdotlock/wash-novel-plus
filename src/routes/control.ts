/**
 * Session Control Routes
 * Pause, resume, and re-roll functionality
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { redis, channels, publishEvent } from '../lib/redis.js';
import { queues, QUEUE_NAMES } from '../lib/queue.js';
import { parseJsonField } from '../lib/json-utils.js';

const ResumeSchema = z.object({
    instruction: z.string().optional(),
});

const RerollSchema = z.object({
    autoReview: z.boolean().optional(),
});

export async function controlRoutes(app: FastifyInstance): Promise<void> {
    // Pause generation
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/pause',
        async (request, reply) => {
            const { id } = request.params;

            // Set pause flag in Redis
            await redis.set(`pause:${id}`, 'true');

            // Update session
            await prisma.session.update({
                where: { id },
                data: { status: 'paused' },
            });

            // Notify via SSE
            await publishEvent(channels.sessionEvents(id), {
                type: 'paused',
                message: '任务已暂停',
            });

            return { success: true, status: 'paused' };
        }
    );

    // Resume generation
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/resume',
        async (request, reply) => {
            const { id } = request.params;
            const body = ResumeSchema.parse(request.body ?? {});

            // Clear pause flag
            await redis.del(`pause:${id}`);

            // Store instruction for next step
            if (body.instruction) {
                await prisma.session.update({
                    where: { id },
                    data: {
                        status: 'executing',
                        // Store instruction in globalMemory for worker to pick up
                        globalMemory: JSON.stringify({
                            ...JSON.parse((await prisma.session.findUnique({
                                where: { id },
                                select: { globalMemory: true }
                            }))?.globalMemory as string || '{}'),
                            nextStepInstruction: body.instruction,
                        }),
                    },
                });
            } else {
                await prisma.session.update({
                    where: { id },
                    data: { status: 'executing' },
                });
            }

            // Notify via SSE
            await publishEvent(channels.sessionEvents(id), {
                type: 'resumed',
                message: '任务继续执行',
            });

            return { success: true, status: 'executing' };
        }
    );

    // Re-roll single node
    app.post<{ Params: { id: string; nodeId: string } }>(
        '/api/sessions/:id/nodes/:nodeId/reroll',
        async (request, reply) => {
            const { id, nodeId } = request.params;
            const nodeIdNum = parseInt(nodeId, 10);
            const body = RerollSchema.parse(request.body ?? {});
            const autoReview = body.autoReview ?? true;

            // Get session
            const session = await prisma.session.findUnique({
                where: { id },
                select: { nodes: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            // Parse and update node status
            const nodes = parseJsonField<Record<string, any>>(session.nodes, {});
            const node = nodes[nodeIdNum];
            if (!node) {
                return reply.status(404).send({ error: 'Node not found' });
            }

            nodes[nodeIdNum] = {
                ...node,
                status: 'pending',
                content: '',
            };

            await prisma.session.update({
                where: { id },
                data: { nodes },
            });

            // Find or create generating task for this session
            let existingTask = await prisma.task.findFirst({
                where: { sessionId: id, type: 'generating' },
                orderBy: { createdAt: 'desc' },
            });

            if (!existingTask) {
                // Create a new task for reroll if none exists
                existingTask = await prisma.task.create({
                    data: {
                        sessionId: id,
                        type: 'generating',
                        status: 'pending',
                        total: 1,
                        progress: 0,
                    },
                });
            }

            // Add reroll job to generating queue
            await queues.generating.add(QUEUE_NAMES.GENERATING, {
                sessionId: id,
                taskId: existingTask.id,
                nodeId: nodeIdNum,
                reroll: true,
                autoReview,
            });

            // Notify via session stream for immediate UI feedback
            await publishEvent(channels.sessionEvents(id), {
                type: 'node_start',
                message: `开始重新生成节点 #${nodeIdNum}`,
                data: { nodeId: nodeIdNum },
            });

            return {
                success: true,
                taskId: existingTask.id,
                nodeId: nodeIdNum,
            };
        }
    );

    // Get current job status
    app.get<{ Params: { id: string } }>(
        '/api/sessions/:id/status',
        async (request, reply) => {
            const { id } = request.params;

            const session = await prisma.session.findUnique({
                where: { id },
                select: { status: true, nodes: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const isPaused = await redis.get(`pause:${id}`) === 'true';
            const nodes = parseJsonField<Record<string, any>>(session.nodes, {});
            const nodeList = Object.values(nodes) as any[];
            const completed = nodeList.filter((n: any) => n.status === 'completed').length;
            const generating = nodeList.find((n: any) => n.status === 'generating');

            return {
                status: isPaused ? 'paused' : session.status,
                totalNodes: nodeList.length,
                completedNodes: completed,
                generatingNodeId: generating?.id || null,
            };
        }
    );
}
