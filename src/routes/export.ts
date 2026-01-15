/**
 * Export Routes
 * Handle data export (e.g. ZIP download)
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import archiver from 'archiver';
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
                    nodes: true,
                },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            // Parse nodes as a loose record so we can read branch metadata as well
            const nodes = parseJsonField<Record<string, any>>(session.nodes, {});
            const nodeList: any[] = Object.values(nodes).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

            // Prepare naming helpers
            const sessionName = session.name || 'session';
            const novelSlug = sanitizeFilename(sessionName).toLowerCase() || 'session';

            // Set headers for download
            const filename = `${sessionName}-${id.slice(0, 6)}.zip`;
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

            // Main-line exports: root of ZIP
            for (const node of nodeList) {
                const isBranch = !!node.branchKind;
                if (isBranch) continue;

                if (node.status === 'completed' && node.content) {
                    const typeLabel = node.type === 'highlight' ? 'highlight' : 'normal';
                    const index = node.id ?? 0;
                    const base = `${index}-${typeLabel}-${novelSlug}`;
                    const nodeFilename = `${base}.md`;
                    archive.append(String(node.content), { name: nodeFilename });
                    hasFiles = true;
                }
            }

            // Branch exports: put into separate folder, grouped by parent node
            const branchCounters: Record<number, number> = {};
            for (const node of nodeList) {
                const isBranch = !!node.branchKind;
                if (!isBranch) continue;
                if (node.status !== 'completed' || !node.content) continue;

                const parentId: number = Number(node.parentNodeId ?? node.id ?? 0) || 0;
                const typeLabel = node.type === 'highlight' ? 'highlight' : 'normal';
                const base = `${parentId}-${typeLabel}-${novelSlug}`;

                branchCounters[parentId] = (branchCounters[parentId] || 0) + 1;
                const branchIndex = branchCounters[parentId];

                // Example: branches/1-highlight-novelname-branchsolo-1.md
                const branchFilename = `branches/${base}-branchsolo-${branchIndex}.md`;
                archive.append(String(node.content), { name: branchFilename });
                hasFiles = true;
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
