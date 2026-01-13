/**
 * Langfuse client for prompt management
 * All prompts are managed through Langfuse - no local storage
 */
import { Langfuse } from 'langfuse';

// Initialize Langfuse client
export const langfuse = new Langfuse({
    secretKey: process.env.LANGFUSE_SECRET_KEY || '',
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
    baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

// Prompt names - these must exist in Langfuse
import { config } from '../config/index.js';

// ... (imports)

// Prompt names - these must exist in Langfuse
export const PROMPT_NAMES = {
    INDEXING: 'wash-indexing',
    PLANNING_AUTO: 'wash-planning-auto',
    PLANNING_SPLIT: 'wash-planning-split',
    PLANNING_MERGE: 'wash-planning-merge',
    PLANNING_ADJUST: 'wash-planning-adjust',
    WASH_GENERATE: 'wash-generate',
    WASH_MEMORY: 'wash-memory',
    REVIEW: 'wash-review',
} as const;

// Cache for prompts (5 min TTL)
const promptCache = new Map<string, { prompt: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Get compiled prompt from Langfuse
 * Automatically appends language suffix based on config
 */
export async function getPrompt(
    baseName: string,
    variables: Record<string, unknown>
): Promise<string | any[]> {
    const lang = config.novelLanguage || 'cn';
    const name = `${baseName}-${lang}`;

    const cached = promptCache.get(name);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        const remainingMs = CACHE_TTL - (Date.now() - cached.timestamp);
        console.log(`📦 [Langfuse] Cache hit: ${name} (expires in ${Math.round(remainingMs / 1000)}s)`);
        return cached.prompt.compile(variables);
    }

    console.log(`🔄 [Langfuse] Fetching: ${name} (lang=${lang})`);

    try {
        const prompt = await langfuse.getPrompt(name);
        promptCache.set(name, { prompt, timestamp: Date.now() });
        console.log(`✅ [Langfuse] Loaded: ${name}`);
        return prompt.compile(variables);
    } catch (error) {
        console.error(`❌ [Langfuse] Error fetching "${name}":`, error);
        throw new Error(`Langfuse Error: Failed to fetch prompt "${name}". Please check you have uploaded the prompt with correct suffix.`);
    }
}

/**
 * Get indexing prompt
 */
export async function getIndexingPrompt(vars: {
    chapterNumber: number;
    chapterTitle: string;
    chapterContent: string;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.INDEXING, vars);
}

/**
 * Get planning prompt based on mode
 * The Langfuse template expects a pre-composed chapter summary string
 */
export async function getPlanningPrompt(vars: {
    mode: 'auto' | 'split' | 'merge';
    chapterSummaries: string;
    targetNodeCount?: number;
    customInstructions?: string;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    const promptName = vars.mode === 'split'
        ? PROMPT_NAMES.PLANNING_SPLIT
        : vars.mode === 'merge'
            ? PROMPT_NAMES.PLANNING_MERGE
            : PROMPT_NAMES.PLANNING_AUTO;
    return getPrompt(promptName, vars);
}

/**
 * Get planning adjustment prompt
 * 用于在初次规划后，根据目标节点数对 events 进行智能合并/拆分。
 */
export async function getPlanningAdjustPrompt(vars: {
    mode: 'auto' | 'split' | 'merge';
    chapterSummaries: string;
    currentEvents: any[];
    targetNodeCount: number;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.PLANNING_ADJUST, vars);
}

/**
 * Get wash/generate prompt
 */
export async function getWashPrompt(vars: {
    nodeId: number;
    nodeType: 'highlight' | 'normal';
    nodeDescription: string;
    chapterContent: string;
    previousContext: string;
    globalMemory: string;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.WASH_GENERATE, vars);
}

/**
 * Get memory update prompt
 */
export async function getMemoryPrompt(vars: {
    nodeContent: string;
    previousMemory: string;
    language: 'cn' | 'en';
}): Promise<string> {
    return getPrompt(PROMPT_NAMES.WASH_MEMORY, vars);
}

/**
 * Get review prompt
 */
export async function getReviewPrompt(vars: {
    nodeContent: string;
    nodeType: 'highlight' | 'normal';
    language: 'cn' | 'en';
}): Promise<string> {
    return getPrompt(PROMPT_NAMES.REVIEW, vars);
}

/**
 * Create observability trace
 */
export function createTrace(name: string, sessionId: string, metadata?: Record<string, unknown>) {
    return langfuse.trace({ name, sessionId, metadata });
}

/**
 * Flush pending events
 */
export async function flushLangfuse(): Promise<void> {
    await langfuse.flushAsync();
}


