/**
 * Worker Bootstrap
 * Start all BullMQ workers
 */
import 'dotenv/config';
import { config, validateConfig } from '../config/index.js';
import { createWorker, QUEUE_NAMES } from '../lib/queue.js';
import { processIndexingJob } from './indexer.js';
import { processPlanningJob } from './planner.js';
import { processGeneratingJob } from './writer.js';
import { processReviewingJob } from './refiner.js';
import { processBranchingJob } from './brancher.js';
import { IndexingJobData, PlanningJobData, GeneratingJobData, ReviewingJobData, BranchingJobData } from '../lib/queue.js';

console.log('🚀 Starting Wash 2.0 Workers...');

// Validate configuration
validateConfig();

// Create workers with appropriate concurrency
const indexingWorker = createWorker<IndexingJobData>(
    QUEUE_NAMES.INDEXING,
    processIndexingJob,
    { concurrency: config.worker.concurrencyIndex }
);

const planningWorker = createWorker<PlanningJobData>(
    QUEUE_NAMES.PLANNING,
    processPlanningJob,
    {
        concurrency: 3, // Planning is relatively lightweight
        lockDurationMs: 5 * 60 * 1000, // 5 minutes to avoid spurious stalled warnings
    }
);

const generatingWorker = createWorker<GeneratingJobData>(
    QUEUE_NAMES.GENERATING,
    processGeneratingJob,
    { concurrency: config.worker.concurrencyGenerate }
);

const reviewingWorker = createWorker<ReviewingJobData>(
    QUEUE_NAMES.REVIEWING,
    processReviewingJob,
    { concurrency: config.worker.concurrencyReview }
);

const branchingWorker = createWorker<BranchingJobData>(
    QUEUE_NAMES.BRANCHING,
    processBranchingJob,
    { concurrency: 1 }
);

// Log worker events (keep this minimal: only failures & stalls by default)
const workers = [indexingWorker, planningWorker, generatingWorker, reviewingWorker, branchingWorker];

workers.forEach((worker) => {
    worker.on('failed', (job, error) => {
        console.error(`❌ [${worker.name}] Job ${job?.id} failed:`, error.message);
    });

    worker.on('stalled', (jobId) => {
        console.warn(`⚠️ [${worker.name}] Job ${jobId} stalled`);
    });
});

console.log('✅ All workers started');
console.log(`   - Indexing: concurrency ${config.worker.concurrencyIndex}`);
console.log('   - Planning: concurrency 3');
console.log(`   - Generating: concurrency ${config.worker.concurrencyGenerate}`);
console.log(`   - Reviewing: concurrency ${config.worker.concurrencyReview}`);
console.log('   - Branching: concurrency 1');

// Graceful shutdown
const shutdown = async (signal: string) => {
    console.log(`\n📭 Received ${signal}, shutting down workers...`);

    await Promise.all(workers.map((w) => w.close()));

    console.log('👋 Workers stopped gracefully');
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
