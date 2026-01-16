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
    PLANNING_BUTTERFLY: 'wash-planning-butterfly',
    WASH_GENERATE: 'wash-generate',
    WASH_MEMORY: 'wash-memory',
    REVIEW: 'wash-review',
    CHARACTER_MAP: 'wash-characters',
    BRANCH_PLAN: 'wash-branch-plan',
    BRANCH_WRITE: 'wash-branch-write',
    BRANCH_EVENTS: 'wash-branch-events',
    RENAME_NODE: 'wash-rename-node',
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
        return cached.prompt.compile(variables as Record<string, string>);
    }

    console.log(`🔄 [Langfuse] Fetching: ${name} (lang=${lang})`);

    try {
        const prompt = await langfuse.getPrompt(name);
        promptCache.set(name, { prompt, timestamp: Date.now() });
        console.log(`✅ [Langfuse] Loaded: ${name}`);
        return prompt.compile(variables as Record<string, string>);
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
 *
 * 注意：currentEvents 以 JSON 字符串形式传入，便于在 Prompt 中直接展示。
 */
export async function getPlanningAdjustPrompt(vars: {
    mode: 'auto' | 'split' | 'merge';
    chapterSummaries: string;
    currentEvents: string; // JSON.stringify(events)
    targetNodeCount: number;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.PLANNING_ADJUST, vars);
}

/**
 * Get butterfly-effect micro-tuning prompt for existing plans
 * 只做细微偏差，保持整体章节覆盖和节奏基本一致。
 */
export async function getPlanningButterflyPrompt(vars: {
    mode: 'auto' | 'split' | 'merge';
    chapterSummaries: string;
    currentEvents: string; // JSON.stringify(events)
    targetNodeCount: number;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.PLANNING_BUTTERFLY, vars);
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
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.WASH_MEMORY, vars);
}

/**
 * Get character map consolidation prompt
 */
export async function getCharacterMapPrompt(vars: {
    charactersJson: string;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.CHARACTER_MAP, vars);
}

/**
 * Get branch planning prompt (decide divergent vs convergent branches)
 */
export async function getBranchPlanPrompt(vars: {
    mainSummary: string;
    targetDivergent: number;
    targetConvergent: number;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.BRANCH_PLAN, vars);
}

/**
 * Get per-branch event planning prompt
 *
 * 该 Prompt 针对「单条支线」，在给定主线上下文和支线概要的前提下，规划 3-8 个离散事件，
 * 每个事件都锚定到某个主线节点（anchorMainNodeId），便于后续写作时引用主线节点内容。
 */
export async function getBranchEventsPrompt(vars: {
    fromNodeId: number;
    returnNodeId?: number | null;
    branchType: 'divergent' | 'convergent';
    branchSummary: string;
    mainContext: string;
    minEvents: number;
    maxEvents: number;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.BRANCH_EVENTS, vars);
}

/**
 * Get branch writing prompt (generate a single branch node)
 */
export async function getBranchWritePrompt(vars: {
    fromNodeId: number;
    baseDescription: string;
    mainSnippet: string;
    branchType: 'divergent' | 'convergent';
    returnSnippet?: string;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.BRANCH_WRITE, vars);
}

/**
 * Get node rename prompt (post-processing character renaming)
 */
export async function getRenameNodePrompt(vars: {
    nodeId: number;
    originalContent: string;
    characterMapJson: string;
    language?: 'cn' | 'en';
}): Promise<string | any[]> {
    return getPrompt(PROMPT_NAMES.RENAME_NODE, vars);
}

/**
 * Get review prompt
 */
export async function getReviewPrompt(vars: {
    nodeContent: string;
    nodeType: 'highlight' | 'normal';
    language: 'cn' | 'en';
}): Promise<string | any[]> {
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


