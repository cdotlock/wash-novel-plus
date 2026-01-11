/**
 * Export Routes
 * Handle data export (e.g. ZIP download)
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import archiver from 'archiver';
import { Node } from '../schemas/node.js';
import { parseJsonField } from '../lib/json-utils.js';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
    // Download all nodes as ZIP
    app.get<{ Params: { id: string } }>(
        '/api/sessions/:id/export',
        async (request, reply) => {
            const { id } = request.params;

            const session = await prisma.session.findUnique({
                where: { id },
                select: {
                    name: true,
                    nodes: true
                },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            const nodes = parseJsonField<Record<string, Node>>(session.nodes, {});
            const nodeList = Object.values(nodes).sort((a, b) => a.id - b.id);

            // Set headers for download
            const filename = `${session.name || 'session'}-${id.slice(0, 6)}.zip`;
            reply.header('Content-Type', 'application/zip');
            reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

            // Create archive
            const archive = archiver('zip', {
                zlib: { level: 9 }, // Max compression
            });

            // Pipe archive to response
            archive.on('error', (err) => {
                throw err;
            });

            archive.pipe(reply.raw);

            // Add files
            let hasFiles = false;
            for (const node of nodeList) {
                if (node.status === 'completed' && node.content) {
                    const typeLabel = node.type === 'highlight' ? 'highlight' : 'normal';
                    const shortTitle = sanitizeFilename(node.description).slice(0, 30) || typeLabel;
                    const nodeFilename = `${String(node.id).padStart(3, '0')}_${shortTitle}_${typeLabel}.md`;
                    archive.append(node.content, { name: nodeFilename });
                    hasFiles = true;
                }
            }

            if (!hasFiles) {
                archive.append('No completed nodes found.', { name: 'README.txt' });
            }

            await archive.finalize();
            return reply; // Helper to signify stream handling
        }
    );
}

function sanitizeFilename(name: string): string {
    return name.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 50);
}
