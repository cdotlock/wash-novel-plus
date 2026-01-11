/**
 * Redis client instance
 * Used for BullMQ queues and Pub/Sub
 */
import Redis from 'ioredis';
import { config } from '../config/index.js';

// Redis connection options with reconnection
const redisOptions = {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    retryStrategy: (times: number) => {
        // Reconnect after delay (max 30 seconds)
        return Math.min(times * 100, 30000);
    },
    reconnectOnError: () => true,
};

// Main Redis connection
export const redis = new Redis(config.redis.url, redisOptions);

redis.on('error', (err) => {
    console.error('Redis connection error:', err.message);
});

redis.on('connect', () => {
    console.log('Redis connected');
});

// Create a duplicate connection for subscribers (Pub/Sub requires separate connection)
export function createSubscriber(): Redis {
    const sub = new Redis(config.redis.url, redisOptions);
    sub.on('error', (err) => {
        console.error('Redis subscriber error:', err.message);
    });
    return sub;
}

// Event channel names
export const channels = {
    jobEvents: (jobId: string) => `job-events:${jobId}`,
    sessionEvents: (sessionId: string) => `session-events:${sessionId}`,
};

// Publish event to Redis
export async function publishEvent(
    channel: string,
    event: {
        type: string;
        message: string;
        data?: Record<string, unknown>;
        timestamp?: string;
    }
): Promise<void> {
    const payload = {
        ...event,
        timestamp: event.timestamp ?? new Date().toISOString(),
    };
    try {
        await redis.publish(channel, JSON.stringify(payload));
    } catch (err) {
        console.error('Failed to publish event:', err);
    }
}

// Note: Don't quit redis on beforeExit as it breaks BullMQ workers
// Graceful shutdown should be handled at application level
