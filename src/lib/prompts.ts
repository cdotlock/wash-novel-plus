/**
 * Prompt Manager
 * Handlebars-based prompt template system with bilingual support
 */
import Handlebars from 'handlebars';
import { readFileSync, readdirSync, watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '../../prompts');

// Template cache
const templates: Map<string, HandlebarsTemplateDelegate> = new Map();

// Register Handlebars helpers
Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('ne', (a, b) => a !== b);
Handlebars.registerHelper('gt', (a, b) => a > b);
Handlebars.registerHelper('lt', (a, b) => a < b);
Handlebars.registerHelper('and', (a, b) => a && b);
Handlebars.registerHelper('or', (a, b) => a || b);
Handlebars.registerHelper('not', (a) => !a);
Handlebars.registerHelper('lang', () => config.novelLanguage);
Handlebars.registerHelper('isCn', () => config.novelLanguage === 'cn');
Handlebars.registerHelper('isEn', () => config.novelLanguage === 'en');

// Load a template
function loadTemplate(name: string): HandlebarsTemplateDelegate {
    const cached = templates.get(name);
    if (cached && config.isProd) {
        return cached;
    }

    const filePath = join(PROMPTS_DIR, `${name}.hbs`);
    try {
        const content = readFileSync(filePath, 'utf-8');
        const compiled = Handlebars.compile(content);
        templates.set(name, compiled);
        return compiled;
    } catch (error) {
        console.error(`Failed to load template: ${name}`, error);
        throw new Error(`Template not found: ${name}`);
    }
}

// Get rendered prompt
export function getPrompt<T extends object>(name: string, context: T = {} as T): string {
    const template = loadTemplate(name);
    return template({ ...context, lang: config.novelLanguage });
}

// Prompt context types
export interface IndexingContext {
    chapterTitle: string;
    chapterContent: string;
}

export interface PlanningContext {
    windowStart: number;
    windowEnd: number;
    windowSize: number;
    mode: string;
    targetNodeCount?: number;
    chapterSummaries: string;
    customInstructions?: string;
}

export interface WashContext {
    eventType: string;
    nodeId: number;
    startChapter: number;
    endChapter: number;
    description: string;
    globalMemory: string;
    chapterContent: string;
    choiceCount: number;
}

export interface MemoryContext {
    currentMemory: string;
    newContent: string;
}

export interface ReviewContext {
    nodeContent: string;
    nodeType: string;
}

// Convenience functions
export const getIndexingPrompt = (ctx: IndexingContext) =>
    getPrompt('indexing', ctx);

export const getPlanningPrompt = (ctx: PlanningContext) =>
    getPrompt('planning', ctx);

export const getWashPrompt = (ctx: WashContext) =>
    getPrompt('wash', ctx);

export const getMemoryPrompt = (ctx: MemoryContext) =>
    getPrompt('memory', ctx);

export const getReviewPrompt = (ctx: ReviewContext) =>
    getPrompt('review', ctx);

// Hot reload for development
export function enableHotReload(): void {
    if (config.isProd) return;

    watch(PROMPTS_DIR, (eventType, filename) => {
        if (filename?.endsWith('.hbs')) {
            const name = filename.replace('.hbs', '');
            templates.delete(name);
            console.log(`🔄 Reloaded prompt: ${name}`);
        }
    });
}

// List available prompts
export function listPrompts(): string[] {
    try {
        return readdirSync(PROMPTS_DIR)
            .filter((f) => f.endsWith('.hbs'))
            .map((f) => f.replace('.hbs', ''));
    } catch {
        return [];
    }
}
