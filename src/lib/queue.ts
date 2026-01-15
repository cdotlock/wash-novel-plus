/**
 * BullMQ Queue definitions
 * Event-driven task processing infrastructure
 */
import { Queue, Worker, Job, FlowProducer, QueueEvents } from 'bullmq';
import { config } from '../config/index.js';

// Dedicated BullMQ Redis connection options.
// Let BullMQ create and manage its own ioredis instances instead of
// sharing the app-level client from src/lib/redis.ts.
const bullConnection = {
    host: new URL(config.redis.url).hostname || '127.0.0.1',
    port: Number(new URL(config.redis.url).port || 6379),
    // These options mirror the important bits from redis.ts that BullMQ cares about.
    maxRetriesPerRequest: null as number | null,
    enableReadyCheck: false,
};

// Queue names
export const QUEUE_NAMES = {
    WASH_FLOW: 'wash-flow',
    INDEXING: 'indexing',
    PLANNING: 'planning',
    GENERATING: 'generating',
    REVIEWING: 'reviewing',
    BRANCHING: 'branching',
} as const;

// Common BullMQ queue options.
// NOTE: We explicitly provide a lockDuration here because BullMQ's
// moveToActive Lua script reads lockDuration from queue.opts and
// passes it to Redis SET ... PX. If it is missing (nil in Lua), Redis
// throws "arguments must be strings or integers". Supplying a sane
// default here fixes that at the source.
const baseQueueOpts: any = {
    connection: bullConnection,
    lockDuration: 30_000,
};

// Queue instances
export const queues = {
    washFlow: new Queue(QUEUE_NAMES.WASH_FLOW, { ...baseQueueOpts }),
    indexing: new Queue(QUEUE_NAMES.INDEXING, { ...baseQueueOpts }),
    planning: new Queue(QUEUE_NAMES.PLANNING, { ...baseQueueOpts }),
    generating: new Queue(QUEUE_NAMES.GENERATING, { ...baseQueueOpts }),
    reviewing: new Queue(QUEUE_NAMES.REVIEWING, { ...baseQueueOpts }),
    branching: new Queue(QUEUE_NAMES.BRANCHING, { ...baseQueueOpts }),
};

// Flow producer for parent-child job relationships
export const flowProducer = new FlowProducer({ connection: bullConnection });

// Job data types
export interface IndexingJobData {
    sessionId: string;
    taskId: string;
    model?: string;
}

export interface PlanningJobData {
    sessionId: string;
    taskId: string;
    mode?: 'auto' | 'split' | 'merge' | 'one_to_one';
    targetNodeCount?: number;
    model?: string;
}

export interface GeneratingJobData {
    sessionId: string;
    taskId: string;
    nodeId?: number; // If specified, regenerate single node
    startFromNode?: number; // Resume from this node
    model?: string;
    autoReview?: boolean;
    // When true, apply character renaming pipeline after generation
    remapCharacters?: boolean;
}

export interface ReviewingJobData {
    sessionId: string;
    taskId: string;
    nodeId?: number; // Review specific node
    autoFix?: boolean;
    model?: string;
}

export interface BranchingJobData {
    sessionId: string;
    taskId: string;
    model?: string;
}

// Create worker with default options
export function createWorker<T>(
    queueName: string,
    processor: (job: Job<T>) => Promise<unknown>,
    options?: {
        concurrency?: number;
        lockDurationMs?: number;
    }
): Worker<T> {
    return new Worker<T>(queueName, processor, {
        connection: bullConnection,
        concurrency: options?.concurrency ?? 5,
        // Increase lock duration for long-running LLM jobs to avoid spurious "stalled" warnings
        // IMPORTANT: Must provide a concrete number. Passing undefined causes BullMQ to encode
        // it via msgpack and Redis Lua rejects non-string/integer arguments.
        lockDuration: options?.lockDurationMs ?? 30_000,
    });
}

// Get queue events for monitoring
export function getQueueEvents(queueName: string): QueueEvents {
    return new QueueEvents(queueName, { connection: bullConnection });
}

// Add job to queue
export async function addJob<T>(
    queueName: keyof typeof queues,
    data: T,
    options?: {
        priority?: number;
        delay?: number;
        attempts?: number;
        backoff?: {
            type: 'exponential' | 'fixed';
            delay: number;
        };
    }
): Promise<Job<T>> {
    const queue = queues[queueName];
    return queue.add(queueName, data, {
        attempts: options?.attempts ?? 3,
        backoff: options?.backoff ?? {
            type: 'exponential',
            delay: 1000,
        },
        ...options,
    }) as Promise<Job<T>>;
}

// Graceful shutdown
export async function closeQueues(): Promise<void> {
    await Promise.all(Object.values(queues).map((q) => q.close()));
    await flowProducer.close();
}
