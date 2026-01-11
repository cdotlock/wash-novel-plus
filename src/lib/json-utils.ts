/**
 * JSON Utilities
 * Robust JSON parsing with Zod validation and jsonrepair
 */
import { jsonrepair } from 'jsonrepair';
import { z, ZodSchema, ZodError } from 'zod';

/**
 * Parse JSON safely with markdown extraction, repair, and schema validation
 */
export function parseJsonSafe<T>(raw: string, schema: ZodSchema<T>): T {
    // Step 1: Extract from markdown code blocks
    let jsonStr = extractJsonFromMarkdown(raw);

    // Step 2: Repair malformed JSON
    try {
        jsonStr = jsonrepair(jsonStr);
    } catch {
        // If repair fails, try to find raw JSON braces
        jsonStr = extractJsonBraces(raw);
    }

    // Step 3: Parse JSON
    const parsed = JSON.parse(jsonStr);

    // Step 4: Validate with Zod
    return schema.parse(parsed);
}
/**
 * Try to parse JSON, return structured result
 */
export function tryParseJson<
    T>(
    raw: string,
    schema: ZodSchema<T>
): { success: true; data: T } | { success: false; error: ZodError | Error } {
    try {
        const data = parseJsonSafe(raw, schema);
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error as ZodError | Error };
    }
}

/**
 * Loosely parse any JSON-like content emitted by an LLM.
 * - Extracts from markdown code blocks if present
 * - Attempts jsonrepair
 * - Falls back to outermost braces
 */
export function parseJsonLoose(raw: string): any {
    // Step 1: Extract from markdown code blocks
    let jsonStr = extractJsonFromMarkdown(raw);

    // Step 2: Repair malformed JSON if possible
    try {
        jsonStr = jsonrepair(jsonStr);
    } catch {
        // If repair fails, try to find raw JSON braces
        jsonStr = extractJsonBraces(raw);
    }

    // Step 3: Parse JSON
    return JSON.parse(jsonStr);
}

/**
 * Extract JSON from markdown code blocks
 */
function extractJsonFromMarkdown(text: string): string {
    // Try ```json blocks first
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch?.[1]) {
        return jsonBlockMatch[1].trim();
    }

    // Try generic ``` blocks
    const codeBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch?.[1]) {
        return codeBlockMatch[1].trim();
    }

    return text;
}

/**
 * Extract JSON by finding outermost braces
 */
function extractJsonBraces(text: string): string {
    // Try object
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return text.slice(firstBrace, lastBrace + 1);
    }

    // Try array
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
        return text.slice(firstBracket, lastBracket + 1);
    }

    return text;
}

/**
 * Clean markdown code block wrappers from content
 */
export function cleanMarkdownCodeBlock(content: string): string {
    let result = content;

    // Remove markdown wrapper
    if (result.startsWith('```markdown')) {
        result = result.slice(11);
    } else if (result.startsWith('```')) {
        result = result.slice(3);
    }

    if (result.endsWith('```')) {
        result = result.slice(0, -3);
    }

    return result.trim();
}

/**
 * Normalize a Prisma Json field that may be stored either as a JSON value
 * or as a JSON-encoded string.
 */
export function parseJsonField<T = unknown>(field: unknown, defaultValue: T): T {
    if (field === null || field === undefined) {
        return defaultValue;
    }

    // Common legacy pattern: JSON-encoded string
    if (typeof field === 'string') {
        const trimmed = field.trim();
        if (!trimmed) return defaultValue;
        try {
            return JSON.parse(trimmed) as T;
        } catch {
            return defaultValue;
        }
    }

    // Already a JSON value (object/array/primitive)
    return field as T;
}
