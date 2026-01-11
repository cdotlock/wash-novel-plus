/**
 * Session Zod Schemas
 * Type definitions for session-related data
 */
import { z } from 'zod';

// Chapter data
export const ChapterSchema = z.object({
    number: z.number(),
    title: z.string(),
    content: z.string(),
});
export type Chapter = z.infer<typeof ChapterSchema>;

// Indexed chapter info
export const ChapterIndexSchema = z.object({
    number: z.number(),
    title: z.string(),
    summary: z.string(),
    characters: z.array(z.string()),
    keyEvent: z.string(),
    type: z.enum(['highlight', 'normal']),
});
export type ChapterIndex = z.infer<typeof ChapterIndexSchema>;

// Session status
export const SessionStatusSchema = z.enum([
    'uploading',
    'indexing',
    'planning',
    'confirmed',
    'executing',
    'completed',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// Content analysis
export const ContentAnalysisSchema = z.object({
    totalChapters: z.number(),
    avgChapterLength: z.number(),
    recommendedMode: z.enum(['split', 'merge', 'normal']).optional(),
    targetNodeCount: z.number().optional(),
});
export type ContentAnalysis = z.infer<typeof ContentAnalysisSchema>;
