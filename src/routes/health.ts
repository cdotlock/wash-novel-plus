/**
 * Health Check Route
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
    // Basic health check
    app.get('/health', async () => {
        return { status: 'ok', timestamp: new Date().toISOString() };
    });

    // Detailed health check
    app.get('/health/detailed', async () => {
        const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

        // Check database
        const dbStart = Date.now();
        try {
            await prisma.$queryRaw`SELECT 1`;
            checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
        } catch (error) {
            checks.database = { status: 'error', error: String(error) };
        }

        // Check Redis
        const redisStart = Date.now();
        try {
            await redis.ping();
            checks.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
        } catch (error) {
            checks.redis = { status: 'error', error: String(error) };
        }

        const allHealthy = Object.values(checks).every((c) => c.status === 'ok');

        return {
            status: allHealthy ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            checks,
        };
    });
}
