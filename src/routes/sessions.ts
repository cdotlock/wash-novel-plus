/**
 * Session Management Routes
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { SessionStatusSchema } from '../schemas/session.js';
import { parseJsonField } from '../lib/json-utils.js';

// Request schemas
const CreateSessionSchema = z.object({
    name: z.string().min(1).max(200),
});

const UpdateSessionSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    status: SessionStatusSchema.optional(),
    characterMap: z.record(z.string(), z.string()).optional(),
});

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
    // List all sessions
    app.get('/api/sessions', async () => {
        const sessions = await prisma.session.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                name: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                planConfirmed: true,
            },
        });

        return { sessions };
    });

    // Get single session
    app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
        const { id } = request.params;

        const session = await prisma.session.findUnique({
            where: { id },
            include: {
                tasks: {
                    orderBy: { createdAt: 'desc' },
                    take: 10,
                },
            },
        });

        if (!session) {
            return reply.status(404).send({ error: 'Session not found' });
        }

        // Parse JSON fields (handle both legacy string and native JSON)
        return {
            ...session,
            chapters: parseJsonField(session.chapters, {}),
            chapterIndex: parseJsonField(session.chapterIndex, []),
            planEvents: parseJsonField(session.planEvents, []),
            nodes: parseJsonField(session.nodes, {}),
            contentAnalysis: parseJsonField(session.contentAnalysis, {}),
            characterMap: parseJsonField((session as any).characterMap, {}),
        };
    });

    // Create new session
    app.post('/api/sessions', async (request) => {
        const body = CreateSessionSchema.parse(request.body);

        const session = await prisma.session.create({
            data: {
                name: body.name,
                status: 'uploading',
            },
        });

        return { session };
    });

    // Update session
    app.patch<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
        const { id } = request.params;
        const body = UpdateSessionSchema.parse(request.body);

        try {
            const session = await prisma.session.update({
                where: { id },
                data: body,
            });

            return { session };
        } catch {
            return reply.status(404).send({ error: 'Session not found' });
        }
    });

    // Delete session
    app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
        const { id } = request.params;

        try {
            await prisma.session.delete({
                where: { id },
            });

            return { success: true };
        } catch {
            return reply.status(404).send({ error: 'Session not found' });
        }
    });

    // Get session nodes
    app.get<{ Params: { id: string } }>('/api/sessions/:id/nodes', async (request, reply) => {
        const { id } = request.params;

        const session = await prisma.session.findUnique({
            where: { id },
            select: { nodes: true, globalMemory: true },
        });

        if (!session) {
            return reply.status(404).send({ error: 'Session not found' });
        }

        const nodes = parseJsonField<Record<string, unknown>>(session.nodes, {});

        return {
            nodes: Object.values(nodes),
            globalMemory: session.globalMemory,
        };
    });

    // Get single node
    app.get<{ Params: { id: string; nodeId: string } }>(
        '/api/sessions/:id/nodes/:nodeId',
        async (request, reply) => {
            const { id, nodeId } = request.params;

            const session = await prisma.session.findUnique({
                where: { id },
                select: { nodes: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const nodes = JSON.parse(session.nodes as string) as Record<string, unknown>;
            const node = nodes[nodeId];

            if (!node) {
                return reply.status(404).send({ error: 'Node not found' });
            }

            return { node };
        }
    );

    // Update node content
    app.patch<{ Params: { id: string; nodeId: string } }>(
        '/api/sessions/:id/nodes/:nodeId',
        async (request, reply) => {
            const { id, nodeId } = request.params;
            const body = request.body as { content?: string; status?: string };

            const session = await prisma.session.findUnique({
                where: { id },
                select: { nodes: true },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const nodes = parseJsonField<Record<string, any>>(session.nodes, {});
            if (!nodes[nodeId]) {
                return reply.status(404).send({ error: 'Node not found' });
            }

            // Update node
            nodes[nodeId] = {
                ...nodes[nodeId],
                ...(body.content !== undefined && { content: body.content }),
                ...(body.status !== undefined && { status: body.status }),
                updatedAt: new Date().toISOString(),
            };

            await prisma.session.update({
                where: { id },
                data: { nodes },
            });

            return { node: nodes[nodeId] };
        }
    );
}
