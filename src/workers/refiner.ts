/**
 * Refiner Worker
 * Process node review jobs
 */
import { Job } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { publishEvent, channels } from '../lib/redis.js';
import { chatWithRetry, getModel, MODEL_ROUTER, TOKEN_LIMITS } from '../lib/llm.js';
import { getReviewPrompt } from '../lib/langfuse.js';
import { tryParseJson, parseJsonField } from '../lib/json-utils.js';
import { ReviewResponseSchema } from '../schemas/llm-responses.js';
import { ReviewingJobData } from '../lib/queue.js';
import { Node } from '../schemas/node.js';

export async function processReviewingJob(job: Job<ReviewingJobData>): Promise<void> {
    const { sessionId, taskId, autoFix, model, nodeId } = job.data;
    const channel = channels.jobEvents(taskId);

    await publishEvent(channel, {
        type: 'thought',
        message: `[Review] Dispatching review job via queue "reviewing" (mode=${nodeId ? 'single-node' : 'batch'}, autoFix=${autoFix ?? false}, model=${model ?? getModel(MODEL_ROUTER.refiner)})`,
        data: {
            worker: 'reviewer',
            queue: 'reviewing',
            mode: nodeId ? 'single' : 'batch',
            autoFix: autoFix ?? false,
            model: model ?? getModel(MODEL_ROUTER.refiner),
        },
    });

    // Get session data
    const session = await prisma.session.findUnique({
        where: { id: sessionId },
    });

    if (!session) {
        throw new Error('Session not found');
    }

    const nodes = parseJsonField<Record<string, Node>>(session.nodes, {});
    let targetNodes: Node[] = [];

    await publishEvent(channel, {
        type: 'thought',
        message: `[Review] 加载会话 ${sessionId}，可审核节点数 ${Object.keys(nodes).length}`,
        data: { sessionId, totalNodes: Object.keys(nodes).length },
    });

    if (nodeId) {
        // Single node review
        const node = nodes[String(nodeId)];
        if (node && node.status === 'completed' && node.content) {
            targetNodes = [node];
        }
    } else {
        // Batch review
        targetNodes = Object.values(nodes)
            .filter((n) => n.status === 'completed' && n.content)
            .sort((a, b) => a.id - b.id);
    }

    const total = targetNodes.length;

    // Update task status (only for batch)
    if (!nodeId) {
        await prisma.task.update({
            where: { id: taskId },
            data: { status: 'running', total },
        });

        await publishEvent(channel, {
            type: 'progress',
            message: `Starting review of ${total} nodes...`,
            data: { progress: 0, total },
        });
    }

    const resolvedModel = model ?? getModel(MODEL_ROUTER.refiner);
    const reviews: Array<{ nodeId: number; score: number; issues: string[] }> = [];

    for (let i = 0; i < targetNodes.length; i++) {
        const node = targetNodes[i];

        await publishEvent(channel, {
            type: 'thought',
            message: `Reviewing node ${node.id} (${i + 1}/${total})...`,
            data: { nodeId: node.id },
        });

        try {
            // Generate review prompt via Langfuse
            const prompt = await getReviewPrompt({
                nodeContent: node.content,
                nodeType: node.type,
                language: 'cn',
            });

            // Call LLM
            const response = await chatWithRetry(prompt, {
                model: resolvedModel,
                maxTokens: TOKEN_LIMITS.refiner,
            });

            // Parse response
            const result = tryParseJson(response, ReviewResponseSchema);

            if (result.success) {
                const review = result.data;

                // Update node with quality score
                nodes[String(node.id)] = {
                    ...nodes[String(node.id)],
                    qualityScore: review.score,
                };

                reviews.push({
                    nodeId: node.id,
                    score: review.score,
                    issues: review.issues,
                });

                await publishEvent(channel, {
                    type: 'log',
                    message: `Node ${node.id} quality: ${review.score}/5`,
                    data: { nodeId: node.id, score: review.score, issues: review.issues },
                });

                await publishEvent(channel, {
                    type: 'thought',
                    message: `[Review] 节点 #${node.id} 评分：${review.score}/5` + (review.issues?.length ? `，问题：${review.issues.join('；')}` : ''),
                    data: { nodeId: node.id, score: review.score },
                });

                // Auto-fix if enabled and score is low
                const rerollCount = (nodes[String(node.id)] as any).rerollCount || 0;

                if (autoFix && review.score <= 3 && rerollCount < 3) {
                    await publishEvent(channel, {
                        type: 'thought',
                        message: `Score ${review.score} too low. Triggering auto re-roll (attempt ${rerollCount + 1}/3)...`,
                        data: { nodeId: node.id },
                    });

                    // Reset node status
                    nodes[String(node.id)] = {
                        ...nodes[String(node.id)],
                        status: 'generating',
                        content: undefined,
                        // @ts-ignore
                        rerollCount: rerollCount + 1,
                    };

                    // Trigger re-roll job (add to generating queue)
                    const { queues } = await import('../lib/queue.js');
                    await queues.generating.add('reroll', {
                        sessionId,
                        taskId,
                        nodeId: node.id,
                        autoReview: true, // Recurse
                    });

                    await publishEvent(channel, {
                        type: 'reroll',
                        message: `Node ${node.id} re-rolling...`,
                        data: { nodeId: node.id },
                    });
                }
            } else {
                console.warn(`Failed to parse review for node ${node.id}`);
            }
        } catch (error) {
            console.error(`Error reviewing node ${node.id}:`, error);
        }
    }

    // Save updated nodes
    await prisma.session.update({
        where: { id: sessionId },
        data: { nodes },
    });

    // Only complete task if batch review
    if (!nodeId) {
        // Calculate stats
        const avgScore = reviews.length > 0
            ? reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length
            : 0;
        const lowScoreCount = reviews.filter((r) => r.score < 3).length;

        await prisma.task.update({
            where: { id: taskId },
            data: {
                status: 'completed',
                progress: 100,
                result: {
                    reviewedCount: reviews.length,
                    avgScore: Math.round(avgScore * 10) / 10,
                    lowScoreCount,
                },
            },
        });

        await publishEvent(channel, {
            type: 'complete',
            message: `Review complete! Average score: ${avgScore.toFixed(1)}/5`,
            data: { reviewedCount: reviews.length, avgScore, lowScoreCount, reviews },
        });
    }
}
