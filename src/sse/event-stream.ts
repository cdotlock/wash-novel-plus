/**
 * SSE Event Stream
 * Server-Sent Events implementation with Redis subscription
 */
import { FastifyReply, FastifyRequest } from 'fastify';
import { createSubscriber, channels } from '../lib/redis.js';

export interface SSEEvent {
    type: string;
    message: string;
    data?: Record<string, unknown>;
    timestamp?: string;
}

/**
 * Create an SSE stream for a job
 */
export async function createJobEventStream(
    request: FastifyRequest<{ Params: { taskId: string } }>,
    reply: FastifyReply
): Promise<void> {
    const { taskId } = request.params;
    const channel = channels.jobEvents(taskId);

    // Set SSE headers
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    // Create Redis subscriber
    const subscriber = createSubscriber();
    let isCleanedUp = false;

    try {
        await subscriber.subscribe(channel);
    } catch (err) {
        console.error('Failed to subscribe to channel:', err);
        reply.raw.end();
        return;
    }

    // Send initial connection event
    sendSSE(reply, { type: 'connected', message: 'Connected to event stream' });

    // Keep-alive interval
    const keepAliveInterval = setInterval(() => {
        try {
            sendSSE(reply, { type: 'heartbeat', message: 'ping' });
        } catch {
            // Connection may be closed
        }
    }, 30000);

    // Cleanup function with error handling
    const cleanup = async () => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        clearInterval(keepAliveInterval);

        try {
            await subscriber.unsubscribe(channel);
        } catch {
            // Ignore unsubscribe errors
        }

        try {
            subscriber.disconnect();
        } catch {
            // Ignore disconnect errors
        }

        try {
            reply.raw.end();
        } catch {
            // Ignore end errors
        }
    };

    // Handle incoming messages
    subscriber.on('message', (receivedChannel: string, message: string) => {
        if (receivedChannel === channel) {
            try {
                const event = JSON.parse(message) as SSEEvent;
                sendSSE(reply, event);

                // Close stream on completion
                if (event.type === 'complete' || event.type === 'error') {
                    cleanup();
                }
            } catch {
                // Ignore parse errors
            }
        }
    });

    subscriber.on('error', (err) => {
        console.error('Subscriber error:', err.message);
    });

    // Handle client disconnect
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
}

/**
 * Create an SSE stream for a session
 */
export async function createSessionEventStream(
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply
): Promise<void> {
    const { sessionId } = request.params;
    const channel = channels.sessionEvents(sessionId);

    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    const subscriber = createSubscriber();
    let isCleanedUp = false;

    try {
        await subscriber.subscribe(channel);
    } catch (err) {
        console.error('Failed to subscribe to channel:', err);
        reply.raw.end();
        return;
    }

    sendSSE(reply, { type: 'connected', message: 'Connected to session stream' });

    const keepAliveInterval = setInterval(() => {
        try {
            sendSSE(reply, { type: 'heartbeat', message: 'ping' });
        } catch {
            // Connection may be closed
        }
    }, 30000);

    const cleanup = async () => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        clearInterval(keepAliveInterval);

        try {
            await subscriber.unsubscribe(channel);
        } catch {
            // Ignore errors
        }

        try {
            subscriber.disconnect();
        } catch {
            // Ignore errors
        }

        try {
            reply.raw.end();
        } catch {
            // Ignore errors
        }
    };

    subscriber.on('message', (receivedChannel: string, message: string) => {
        if (receivedChannel === channel) {
            try {
                const event = JSON.parse(message) as SSEEvent;
                sendSSE(reply, event);
            } catch {
                // Ignore parse errors
            }
        }
    });

    subscriber.on('error', (err) => {
        console.error('Subscriber error:', err.message);
    });

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
}

/**
 * Send an SSE event
 */
function sendSSE(reply: FastifyReply, event: SSEEvent): void {
    try {
        const data = JSON.stringify({
            ...event,
            timestamp: event.timestamp ?? new Date().toISOString(),
        });
        reply.raw.write(`data: ${data}\n\n`);
    } catch {
        // Connection may be closed
    }
}
