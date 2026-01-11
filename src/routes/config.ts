/**
 * Config Route
 * Expose minimal runtime configuration to the web UI
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';

export async function configRoutes(app: FastifyInstance): Promise<void> {
    app.get('/api/config', async () => {
        return {
            // Frontend currently only uses language, but we expose
            // a bit more for future debugging/UX tweaks.
            language: config.novelLanguage,
            llm: {
                baseUrl: config.llm.baseUrl,
                modelChat: config.llm.modelChat,
                modelReasoning: config.llm.modelReasoning,
            },
        };
    });
}