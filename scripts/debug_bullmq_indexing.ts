import 'dotenv/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../src/config/index.js';
import { redis } from '../src/lib/redis.js';

// 使用一个临时 ioredis client（简单配置）
async function testSimpleSharedClient() {
    console.log('=== Test 1: simple shared ioredis client ===');

    const client = new Redis(config.redis.url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });

    const queue = new Queue('indexing', { connection: client });

    try {
        const job = await queue.add('indexing', { foo: 'bar' }, {
            attempts: 1,
            backoff: { type: 'exponential', delay: 1000 },
        });
        console.log('Job added (simple shared client):', job.id);
    } catch (err) {
        console.error('Error (simple shared client):', err);
    } finally {
        await queue.close();
        client.disconnect();
    }
}

// 使用项目里真正 export 的 redis 实例（带 retryStrategy / reconnectOnError 等）
async function testAppRedisInstance() {
    console.log('=== Test 2: app redis.ts shared instance ===');

    const queue = new Queue('indexing', { connection: redis });

    try {
        const job = await queue.add('indexing', { foo: 'bar' }, {
            attempts: 1,
            backoff: { type: 'exponential', delay: 1000 },
        });
        console.log('Job added (app redis instance):', job.id);
    } catch (err) {
        console.error('Error (app redis instance):', err);
    } finally {
        await queue.close();
    }
}

// 使用 BullMQ 自己管理的 connection options
async function testBullInternalConnection() {
    console.log('=== Test 3: BullMQ internal connection options ===');

    const url = new URL(config.redis.url);
    const host = url.hostname || '127.0.0.1';
    const port = url.port ? Number(url.port) : 6379;

    const queue = new Queue('indexing', {
        connection: {
            host,
            port,
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        } as any,
    });

    try {
        const job = await queue.add('indexing', { foo: 'bar' }, {
            attempts: 1,
            backoff: { type: 'exponential', delay: 1000 },
        });
        console.log('Job added (BullMQ connection):', job.id);
    } catch (err) {
        console.error('Error (BullMQ connection):', err);
    } finally {
        await queue.close();
    }
}

async function main() {
    await testSimpleSharedClient();
    await testAppRedisInstance();
    await testBullInternalConnection();
}

main().catch((err) => {
    console.error('Unexpected error in debug script:', err);
    process.exit(1);
});
