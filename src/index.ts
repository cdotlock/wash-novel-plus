/**
 * Wash 2.0 API Server
 * Main entry point
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, validateConfig } from './config/index.js';
import { prisma } from './lib/prisma.js';
import { closeQueues } from './lib/queue.js';
import {
    healthRoutes,
    sessionRoutes,
    uploadRoutes,
    indexingRoutes,
    planningRoutes,
    generatingRoutes,
    controlRoutes,
    exportRoutes,
    configRoutes,
    reviewRoutes,
    branchingRoutes,
} from './routes/index.js';

// Create Fastify instance
// Default to a quieter logger in dev; detailed request logs can be re-enabled
// by changing the level to 'info' when needed.
const app = Fastify({
    logger: {
        level: config.isDev ? 'warn' : 'warn',
    },
});

// Register CORS
await app.register(cors, {
    origin: true, // Allow all origins in development
    credentials: true,
});

// Global error handler
app.setErrorHandler((error: any, request, reply) => {
    const err = error as any;
    app.log.error(err);

    // Zod validation errors
    if (err?.name === 'ZodError') {
        return reply.status(400).send({
            error: 'Validation error',
            details: err.issues,
        });
    }

    // Default error response
    return reply.status(err?.statusCode ?? 500).send({
        error: err?.message ?? 'Internal server error',
    });
});

// Register routes
await app.register(healthRoutes);
await app.register(sessionRoutes);
await app.register(uploadRoutes);
await app.register(indexingRoutes);
await app.register(planningRoutes);
await app.register(generatingRoutes);
await app.register(controlRoutes);
await app.register(exportRoutes);
await app.register(configRoutes);
await app.register(reviewRoutes);
await app.register(branchingRoutes);

// Graceful shutdown
const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);

    try {
        await app.close();
        await closeQueues();
        await prisma.$disconnect();
        process.exit(0);
    } catch (error) {
        app.log.error({ err: error }, 'Error during shutdown');
        process.exit(1);
    }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start server
async function start() {
    try {
        // Validate configuration
        validateConfig();

        // Connect to database
        await prisma.$connect();
        app.log.info('Connected to database');

        // Start listening
        await app.listen({
            port: config.server.port,
            host: config.server.host,
        });

        app.log.info(`Server running at http://${config.server.host}:${config.server.port}`);
    } catch (error) {
        // Log full error details to stderr for easier debugging
        // Note: "error" is typed as unknown in TS, but at runtime it's fine to print.
        // eslint-disable-next-line no-console
        console.error('Start error:', error);
        app.log.error({ err: error as any }, 'Failed to start server');
        process.exit(1);
    }
}

start();
