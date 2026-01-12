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
    planner: 4000,
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

            // Check if rate limited (429)
            if ((error as any)?.status === 429) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1) * (0.5 + Math.random()), 30000);
                console.warn(`Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }

            // Rethrow non-retryable errors
            throw error;
        }
    }

    throw lastError ?? new Error('Max retries exceeded');
}
