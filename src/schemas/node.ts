/**
 * Node Zod Schemas
 * Type definitions for node-related data
 */
import { z } from 'zod';
import { EventTypeSchema } from './plan.js';

// Node status
export const NodeStatusSchema = z.enum([
    'pending',
    'generating',
    'completed',
    'error',
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

// Node data
export const NodeSchema = z.object({
    id: z.number(),
    type: EventTypeSchema,
    startChapter: z.number(),
    endChapter: z.number(),
    description: z.string(),
    content: z.string().default(''),
    status: NodeStatusSchema.default('pending'),
    qualityScore: z.number().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
});
export type Node = z.infer<typeof NodeSchema>;

// Node update request
export const NodeUpdateRequestSchema = z.object({
    content: z.string().optional(),
    status: NodeStatusSchema.optional(),
    qualityScore: z.number().optional(),
});
export type NodeUpdateRequest = z.infer<typeof NodeUpdateRequestSchema>;

// Character appearance info
export const CharacterAppearanceSchema = z.object({
    name: z.string(),
    identity: z.string(),
    appearance: z.object({
        hair: z.string(),
        eyes: z.string(),
        clothing: z.string(),
        accessories: z.string(),
        special: z.string(),
    }),
});
export type CharacterAppearance = z.infer<typeof CharacterAppearanceSchema>;

// Choice/Decision in node
export const ChoiceSchema = z.object({
    id: z.number(),
    requiresCheck: z.boolean(),
    situation: z.string(),
    options: z.array(z.object({
        description: z.string(),
        result: z.string(),
        checkLogic: z.object({
            attribute: z.enum(['combat', 'intelligence', 'charisma', 'willpower']),
            difficulty: z.enum(['easy', 'normal', 'challenge', 'hard', 'hell']),
        }).optional(),
        successResult: z.string().optional(),
        failureResult: z.string().optional(),
    })),
});
export type Choice = z.infer<typeof ChoiceSchema>;
