/**
 * LLM Response Schemas
 * Zod schemas for validating LLM output
 */
import { z } from 'zod';

// Indexing response from LLM
// Support both simple string character names and rich { name, description } objects.
const IndexingCharacterSchema = z.union([
    z.string(),
    z.object({
        name: z.string(),
        description: z.string().optional(),
    }),
]);

export const IndexingResponseSchema = z.object({
    summary: z.string(),
    characters: z
        .array(IndexingCharacterSchema)
        .transform((arr) => arr.map((c) => (typeof c === 'string' ? c : c.name))),
    key_event: z.string(),
    type: z.enum(['highlight', 'daily', 'normal']).transform((v) =>
        v === 'daily' ? 'normal' : v
    ),
});
export type IndexingResponse = z.infer<typeof IndexingResponseSchema>;

// Planning event from LLM
export const PlanningEventSchema = z.object({
    id: z.number(),
    type: z.enum(['highlight', 'normal']),
    start_chapter: z.number(),
    end_chapter: z.number(),
    description: z.string(),
    scene_count: z.number().optional().default(1),
});

// Full planning response
// Support both shapes:
// 1) { events: [...], rationale? }
// 2) [ ... ] directly
export const LLMPlanningResponseSchema = z.union([
    z.object({
        events: z.array(PlanningEventSchema),
        rationale: z.string().optional(),
    }),
    z.array(PlanningEventSchema),
]);
export type LLMPlanningResponse = z.infer<typeof LLMPlanningResponseSchema>;

// Review response from LLM
export const ReviewResponseSchema = z.object({
    score: z.number().min(1).max(5),
    completeness: z.number().min(1).max(5),
    emotionalImpact: z.number().min(1).max(5),
    logicalConsistency: z.number().min(1).max(5),
    choiceQuality: z.number().min(1).max(5),
    issues: z.array(z.string()),
    suggestions: z.array(z.string()),
});
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

// Memory update - no strict schema, just text
export const MemoryUpdateSchema = z.string();
