/**
 * Prisma client instance
 * Singleton pattern for database connections
 */
import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';

// Global prisma instance for development (prevents multiple instances during hot reload)
const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        // In development we keep only warnings and errors; query-level logging
        // is too noisy once the system is stable.
        log: config.isDev ? ['warn', 'error'] : ['error'],
    });

if (config.isDev) {
    globalForPrisma.prisma = prisma;
}

// Graceful shutdown
process.on('beforeExit', async () => {
    await prisma.$disconnect();
});
