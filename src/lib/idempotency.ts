/**
 * Idempotency utilities
 * Request deduplication and idempotency key management
 */
import { redis } from './redis.js';
import { computeContentHash } from './cache.js';

const IDEMPOTENCY_PREFIX = 'wash:idem:';
const DEFAULT_TTL = 300; // 5 minutes

/**
 * Check if a request is duplicate and return cached result if exists
 */
export async function checkIdempotency<T>(
    key: string
): Promise<{ isDuplicate: boolean; result?: T }> {
    try {
        const cached = await redis.get(`${IDEMPOTENCY_PREFIX}${key}`);
        if (cached) {
            return { isDuplicate: true, result: JSON.parse(cached) as T };
        }
        return { isDuplicate: false };
    } catch (error) {
        console.warn('Idempotency check error:', error);
        return { isDuplicate: false };
    }
}

/**
 * Store idempotency result
 */
export async function storeIdempotencyResult<T>(
    key: string,
    result: T,
    ttl: number = DEFAULT_TTL
): Promise<void> {
    try {
        await redis.setex(`${IDEMPOTENCY_PREFIX}${key}`, ttl, JSON.stringify(result));
    } catch (error) {
        console.warn('Idempotency store error:', error);
    }
}

/**
 * Build idempotency key from operation context
 */
export function buildIdempotencyKey(
    sessionId: string,
    operation: string,
    contentHash?: string
): string {
    const parts = [sessionId, operation];
    if (contentHash) {
        parts.push(contentHash);
    }
    return parts.join(':');
}

/**
 * Wrapper for idempotent operations
 */
export async function withIdempotency<T>(
    key: string,
    operation: () => Promise<T>,
    ttl?: number
): Promise<T> {
    const { isDuplicate, result } = await checkIdempotency<T>(key);
    if (isDuplicate && result !== undefined) {
        console.log(`[Idempotency] Returning cached result for key: ${key}`);
        return result;
    }

    const operationResult = await operation();
    await storeIdempotencyResult(key, operationResult, ttl);
    return operationResult;
}
