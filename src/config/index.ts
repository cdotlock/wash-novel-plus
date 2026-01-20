/**
 * Environment configuration
 * Centralized config management with validation
 */
import 'dotenv/config';

export const config = {
    // Database
    database: {
        url: process.env.DATABASE_URL || 'postgresql://wash:wash@localhost:15432/wash?schema=public',
    },

    // Redis
    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:16379',
    },

    // LLM Configuration
    llm: {
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        modelChat: process.env.DEEPSEEK_MODEL_CHAT || 'deepseek-chat',
        modelReasoning: process.env.DEEPSEEK_MODEL_REASONING || 'deepseek-reasoner',
    },

    // Worker Configuration
    worker: {
        concurrencyIndex: parseInt(process.env.WORKER_CONCURRENCY_INDEX || '5', 10),
        concurrencyGenerate: parseInt(process.env.WORKER_CONCURRENCY_GENERATE || '3', 10),
        concurrencyReview: parseInt(process.env.WORKER_CONCURRENCY_REVIEW || '5', 10),
    },

    // Server Configuration
    server: {
        port: parseInt(process.env.PORT || '3000', 10),
        host: process.env.HOST || '0.0.0.0',
    },

    // Language
    novelLanguage: (process.env.NOVEL_LANGUAGE || 'cn') as 'cn' | 'en',

    // Environment
    isDev: process.env.NODE_ENV !== 'production',
    isProd: process.env.NODE_ENV === 'production',
};

// Validate required config
export function validateConfig(): void {
    const errors: string[] = [];

    if (!config.llm.apiKey) {
        errors.push('DEEPSEEK_API_KEY is required');
    }

    if (errors.length > 0) {
        console.warn('⚠️ Configuration warnings:');
        errors.forEach((e) => console.warn(`  - ${e}`));
    }
}
