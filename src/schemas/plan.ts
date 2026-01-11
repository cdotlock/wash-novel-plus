/**
 * Plan Zod Schemas
 * Type definitions for planning-related data
 */
import { z } from 'zod';

// Event type
export const EventTypeSchema = z.enum(['highlight', 'normal']);
export type EventType = z.infer<typeof EventTypeSchema>;

// Event plan (before confirmation)
export const EventPlanSchema = z.object({
    id: z.number(),
    type: EventTypeSchema,
    startChapter: z.number(),
    endChapter: z.number(),
    description: z.string(),
    sceneCount: z.number().default(1),
});
export type EventPlan = z.infer<typeof EventPlanSchema>;

// Planning mode
export const PlanningModeSchema = z.enum(['auto', 'split', 'merge', 'one_to_one']);
export type PlanningMode = z.infer<typeof PlanningModeSchema>;

// LLM planning response
export const PlanningResponseSchema = z.object({
    events: z.array(EventPlanSchema),
    rationale: z.string().optional(),
});
export type PlanningResponse = z.infer<typeof PlanningResponseSchema>;

// Planning request
export const PlanConfigRequestSchema = z.object({
    mode: PlanningModeSchema.optional(),
    targetNodeCount: z.number().optional(),
    customInstructions: z.string().optional(),
});
export type PlanConfigRequest = z.infer<typeof PlanConfigRequestSchema>;

// Plan update request
export const PlanUpdateRequestSchema = z.object({
    events: z.array(EventPlanSchema).optional(),
    confirmed: z.boolean().optional(),
});
export type PlanUpdateRequest = z.infer<typeof PlanUpdateRequestSchema>;
