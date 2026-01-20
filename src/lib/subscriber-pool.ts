/**
 * SSE Subscriber Pool
 * Shared Redis subscribers to reduce connection overhead
 */
import { Redis } from 'ioredis';
import { config } from '../config/index.js';

interface PooledSubscriber {
    subscriber: Redis;
    channels: Set<string>;
    refCount: number;
    createdAt: number;
}

// Singleton subscriber pool
const subscriberPool = new Map<string, PooledSubscriber>();
const MAX_CHANNELS_PER_SUBSCRIBER = 100;
const CLEANUP_INTERVAL = 60000; // 1 minute

// Redis connection options
const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times: number) => Math.min(times * 100, 30000),
};

/**
 * Get or create a subscriber for a channel
 */
export function getSubscriber(channel: string): { subscriber: Redis; release: () => void } {
    // Find existing subscriber with capacity
    for (const [poolKey, pooled] of subscriberPool) {
        if (pooled.channels.size < MAX_CHANNELS_PER_SUBSCRIBER) {
            pooled.channels.add(channel);
            pooled.refCount++;

            return {
                subscriber: pooled.subscriber,
                release: () => releaseSubscriber(poolKey, channel),
            };
        }
    }

    // Create new subscriber
    const poolKey = `subscriber-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const subscriber = new Redis(config.redis.url, redisOptions);

    subscriber.on('error', (err: Error) => {
        console.error(`[SubscriberPool] Redis error on ${poolKey}:`, err.message);
    });

    const pooled: PooledSubscriber = {
        subscriber,
        channels: new Set([channel]),
        refCount: 1,
        createdAt: Date.now(),
    };

    subscriberPool.set(poolKey, pooled);

    return {
        subscriber,
        release: () => releaseSubscriber(poolKey, channel),
    };
}

/**
 * Release a subscriber reference
 */
function releaseSubscriber(poolKey: string, channel: string): void {
    const pooled = subscriberPool.get(poolKey);
    if (!pooled) return;

    pooled.channels.delete(channel);
    pooled.refCount--;

    // Cleanup if no more references
    if (pooled.refCount <= 0) {
        try {
            pooled.subscriber.disconnect();
        } catch {
            // Ignore disconnect errors
        }
        subscriberPool.delete(poolKey);
    }
}

/**
 * Get pool statistics
 */
export function getPoolStats(): {
    subscriberCount: number;
    totalChannels: number;
    totalRefs: number;
} {
    let totalChannels = 0;
    let totalRefs = 0;

    for (const pooled of subscriberPool.values()) {
        totalChannels += pooled.channels.size;
        totalRefs += pooled.refCount;
    }

    return {
        subscriberCount: subscriberPool.size,
        totalChannels,
        totalRefs,
    };
}

/**
 * Cleanup idle subscribers
 */
export function cleanupIdleSubscribers(maxIdleMs: number = 300000): void {
    const now = Date.now();

    for (const [poolKey, pooled] of subscriberPool) {
        if (pooled.refCount <= 0 && (now - pooled.createdAt) > maxIdleMs) {
            try {
                pooled.subscriber.disconnect();
            } catch {
                // Ignore
            }
            subscriberPool.delete(poolKey);
        }
    }
}

// Periodic cleanup
setInterval(() => cleanupIdleSubscribers(), CLEANUP_INTERVAL);
