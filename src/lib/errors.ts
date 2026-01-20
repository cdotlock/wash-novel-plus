/**
 * Error utilities
 * Unified error types and handling
 */

/**
 * Base error class for Wash system
 */
export class WashError extends Error {
    constructor(
        message: string,
        public code: string,
        public context?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'WashError';
    }
}

/**
 * LLM-related errors
 */
export class LLMError extends WashError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, 'LLM_ERROR', context);
        this.name = 'LLMError';
    }
}

/**
 * Validation errors
 */
export class ValidationError extends WashError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, 'VALIDATION_ERROR', context);
        this.name = 'ValidationError';
    }
}

/**
 * Resource not found errors
 */
export class NotFoundError extends WashError {
    constructor(resource: string, id: string) {
        super(`${resource} not found: ${id}`, 'NOT_FOUND', { resource, id });
        this.name = 'NotFoundError';
    }
}

/**
 * Standard log format for errors
 */
export function formatErrorLog(
    error: Error,
    context?: Record<string, unknown>
): Record<string, unknown> {
    const base = {
        errorName: error.name,
        errorMessage: error.message,
        timestamp: new Date().toISOString(),
    };

    if (error instanceof WashError) {
        return {
            ...base,
            errorCode: error.code,
            errorContext: { ...error.context, ...context },
        };
    }

    return {
        ...base,
        errorContext: context,
        stack: error.stack,
    };
}

/**
 * Wrap async function with standard error logging
 */
export function withErrorLogging<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    operationName: string
): T {
    return (async (...args: Parameters<T>) => {
        try {
            return await fn(...args);
        } catch (error) {
            console.error(`[${operationName}] Error:`, formatErrorLog(error as Error));
            throw error;
        }
    }) as T;
}
