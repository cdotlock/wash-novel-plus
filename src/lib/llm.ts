/**
 * LLM Client
 * DeepSeek integration with model routing
 */
import OpenAI from 'openai';
import { config } from '../config/index.js';

// Singleton client instance
let clientInstance: OpenAI | null = null;

export function getClient(): OpenAI {
    if (!clientInstance) {
        clientInstance = new OpenAI({
            apiKey: config.llm.apiKey,
            baseURL: config.llm.baseUrl,
        });
    }
    return clientInstance;
}

// Model types for different tasks
export type ModelType = 'chat' | 'reasoning';

// Get model name for task type
export function getModel(type: ModelType): string {
    switch (type) {
        case 'reasoning':
            return config.llm.modelReasoning;
        case 'chat':
        default:
            return config.llm.modelChat;
    }
}

// Model router: Maps agent types to appropriate models
export const MODEL_ROUTER = {
    indexer: 'chat' as ModelType,      // Fast summarization
    planner: 'chat' as ModelType,      // Planning prefers stable JSON over long CoT
    writer: 'reasoning' as ModelType,  // Content generation
    refiner: 'reasoning' as ModelType, // Quality review
} as const;

// Token limits
export const TOKEN_LIMITS = {
    indexer: 2000,
    planner: 8192,  // DeepSeek API max is 8192
    writer: 8192,
    refiner: 4000,
    memory: 1500,
} as const;

// Chat completion options
export interface ChatOptions {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
}

// Simple chat completion
export async function chat(
    prompt: string | any[],
    options?: ChatOptions
): Promise<string> {
    const client = getClient();
    const messages = Array.isArray(prompt)
        ? prompt
        : [{ role: 'user', content: prompt }];

    const response = await client.chat.completions.create({
        model: options?.model ?? config.llm.modelChat,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        messages,
    });

    return response.choices[0]?.message?.content ?? '';
}

// Streaming chat completion
export async function* chatStream(
    prompt: string | any[],
    options?: ChatOptions
): AsyncGenerator<string> {
    const client = getClient();
    const messages = Array.isArray(prompt)
        ? prompt
        : [{ role: 'user', content: prompt }];

    const stream = await client.chat.completions.create({
        model: options?.model ?? config.llm.modelChat,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        messages,
        stream: true,
    });

    for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
            yield content;
        }
    }
}

// Retry with exponential backoff
export async function chatWithRetry(
    prompt: string | any[],
    options?: ChatOptions & { maxRetries?: number }
): Promise<string> {
    const maxRetries = options?.maxRetries ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await chat(prompt, options);
        } catch (error) {
            lastError = error as Error;
            const status = (error as any)?.status;
            const errorCode = (error as any)?.code;

            // Check if this is a retryable error:
            // - Rate limit (429)
            // - Server errors (500, 502, 503, 504)
            // - Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND)
            const isRateLimited = status === 429;
            const isServerError = status >= 500 && status < 600;
            const isNetworkError = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(errorCode);

            if (isRateLimited || isServerError || isNetworkError) {
                const baseDelay = isRateLimited ? 1000 : 500;
                const delay = Math.min(baseDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random()), 30000);

                const reason = isRateLimited ? 'Rate limited'
                    : isServerError ? `Server error (${status})`
                        : `Network error (${errorCode})`;

                console.warn(`${reason}, retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }

            // Rethrow non-retryable errors (4xx client errors, etc.)
            throw error;
        }
    }

    throw lastError ?? new Error('Max retries exceeded');
}
