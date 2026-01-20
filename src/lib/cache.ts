/**
 * Cache utilities
 * Content hashing and caching mechanism
 */
import { redis } from './redis.js';
import crypto from 'crypto';

const CACHE_PREFIX = 'wash:cache:';
const DEFAULT_TTL = 3600; // 1 hour

/**
 * Compute SHA-256 hash of content
 */
export function computeContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Get cached result by key
 */
export async function getCachedResult<T>(key: string): Promise<T | null> {
    try {
        const cached = await redis.get(`${CACHE_PREFIX}${key}`);
        if (cached) {
            return JSON.parse(cached) as T;
        }
        return null;
    } catch (error) {
        console.warn('Cache get error:', error);
        return null;
    }
}

/**
 * Set cached result
 */
export async function setCachedResult<T>(
    key: string,
    value: T,
    ttl: number = DEFAULT_TTL
): Promise<void> {
    try {
        await redis.setex(`${CACHE_PREFIX}${key}`, ttl, JSON.stringify(value));
    } catch (error) {
        console.warn('Cache set error:', error);
    }
}

/**
 * Invalidate cache by key
 */
export async function invalidateCache(key: string): Promise<void> {
    try {
        await redis.del(`${CACHE_PREFIX}${key}`);
    } catch (error) {
        console.warn('Cache invalidate error:', error);
    }
}

/**
 * Build cache key from operation and content hash
 */
export function buildCacheKey(operation: string, ...parts: string[]): string {
    return `${operation}:${parts.join(':')}`;
}
