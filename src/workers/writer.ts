/**
 * Writer Worker
 * Process node generation jobs (two-stage: content + memory)
 */
import { Job } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { redis, publishEvent, channels } from '../lib/redis.js';
import { chatWithRetry, getModel, MODEL_ROUTER, TOKEN_LIMITS } from '../lib/llm.js';
import { getWashPrompt, getMemoryPrompt, getRenameNodePrompt } from '../lib/langfuse.js';
import { cleanMarkdownCodeBlock, parseJsonField } from '../lib/json-utils.js';
import { GeneratingJobData } from '../lib/queue.js';
import { Chapter } from '../schemas/session.js';
import { Node } from '../schemas/node.js';
import { config } from '../config/index.js';
import { appendMemoryEntry, getMemoryContext } from '../lib/memory.js';
import { isCn, tr } from '../lib/i18n.js';
import { buildChapterContent } from '../lib/chapter-utils.js';
import { applyCharacterMapStringReplace } from '../lib/character-utils.js';

export async function processGeneratingJob(job: Job<GeneratingJobData>): Promise<void> {
    const { sessionId, taskId, nodeId, startFromNode, model, remapCharacters } = job.data;
    const channel = channels.jobEvents(taskId);

    console.log(`\n✍️  [Writer] Starting job for session: ${sessionId.slice(0, 8)}...`);
    console.log(`   Task: ${taskId}, NodeId: ${nodeId ?? 'all'}, Model: ${model ?? getModel(MODEL_ROUTER.writer)}`);
    console.log(`   RemapCharacters: ${remapCharacters}`);

    // Get session data
    const session = await prisma.session.findUnique({
        where: { id: sessionId },
    });

    if (!session) {
        throw new Error('Session not found');
    }

    const chapters = parseJsonField<Record<string, Chapter>>(session.chapters, {});
    const nodes = parseJsonField<Record<string, Node>>(session.nodes, {});

    const characterMap = parseJsonField<Record<string, string>>(
        // characterMap may be stored as JSON or string; normalize here
        (session as any).characterMap ?? {},
        {},
    );

    // 会话级角色改名开关（由上传/生成阶段写入 contentAnalysis.remapCharacters）
    const contentAnalysis = parseJsonField<Record<string, any>>(
        (session as any).contentAnalysis ?? {},
        {},
    );
    const remapCharactersEnabled = !!contentAnalysis.remapCharacters;

    // Sliding-window memory context based on MemoryLog (append-only)
    let globalMemory = await getMemoryContext(sessionId);

    // For backward compatibility, also fall back to legacy globalMemory if no logs yet
    if (!globalMemory && session.globalMemory) {
        globalMemory = session.globalMemory;
    }

    await publishEvent(channel, {
        type: 'thought',
        message: tr(
            `[Writer] 加载会话，共 ${Object.keys(nodes).length} 个节点，模型 ${model ?? getModel(MODEL_ROUTER.writer)}`,
            `[Writer] Session loaded. ${Object.keys(nodes).length} nodes. Model: ${model ?? getModel(MODEL_ROUTER.writer)}`
        ),
        data: { sessionId, totalNodes: Object.keys(nodes).length },
    });

    // Determine which nodes to process
    let nodesToProcess: Node[];

    if (nodeId !== undefined) {
        // Single node regeneration
        const node = nodes[String(nodeId)];
        if (!node) {
            throw new Error(`Node ${nodeId} not found`);
        }
        nodesToProcess = [node];
    } else {
        // All nodes, optionally starting from a specific one
        nodesToProcess = Object.values(nodes)
            .sort((a, b) => a.id - b.id)
            .filter((n) => !startFromNode || n.id >= startFromNode);
    }

    const total = nodesToProcess.length;

    // Update task status
    await prisma.task.update({
        where: { id: taskId },
        data: { status: 'running', total },
    });

    await publishEvent(channel, {
        type: 'progress',
        message: `Starting generation of ${total} nodes...`,
        data: { progress: 0, total },
    });

    const resolvedModel = model ?? getModel(MODEL_ROUTER.writer);
    let generatedCount = 0;

    for (const node of nodesToProcess) {
        // Skip completed nodes (unless explicitly regenerating)
        if (node.status === 'completed' && node.content && nodeId === undefined) {
            generatedCount++;
            continue;
        }

        await publishEvent(channel, {
            type: 'thought',
            message: tr(
                `[Writer] 开始处理节点 #${node.id} (${node.type})，章节 ${node.startChapter}-${node.endChapter}`,
                `[Writer] Starting node #${node.id} (${node.type}), chapters ${node.startChapter}-${node.endChapter}`
            ),
            data: { nodeId: node.id, type: node.type },
        });

        // Update node status
        nodes[String(node.id)] = { ...nodes[String(node.id)], status: 'generating' };
        await prisma.session.update({
            where: { id: sessionId },
            data: { nodes },
        });

        await publishEvent(channel, {
            type: 'progress',
            message: `Generating node ${node.id}: ${node.description.slice(0, 50)}...`,
            data: { progress: Math.floor((generatedCount / total) * 100), nodeId: node.id },
        });

        try {
            // Check for pause before each node
            const isPaused = await redis.get(`pause:${sessionId}`);
            if (isPaused === 'true') {
                await publishEvent(channel, {
                    type: 'paused',
                    message: 'Generation paused by user',
                });
                // Re-queue remaining nodes
                break;
            }

            // Emit node_start event with bilingual message
            await publishEvent(channel, {
                type: 'node_start',
                message: tr(
                    `🚀 开始生成节点 #${node.id}：${node.description.slice(0, 40)}...`,
                    `🚀 Starting node #${node.id}: ${node.description.slice(0, 40)}...`
                ),
                data: { nodeId: node.id, type: node.type },
            });

            // Stage 1: Generate content
            await publishEvent(channel, {
                type: 'thought',
                message: tr(
                    `[思考中] 正在生成节点 #${node.id} 的内容（模型：${resolvedModel}）`,
                    `[Thinking] Generating content for node #${node.id} (Model: ${resolvedModel})`
                ),
                data: { nodeId: node.id, model: resolvedModel },
            });

            // Build chapter content
            const chapterContent = buildChapterContent(chapters, node.startChapter, node.endChapter);
            const choiceCount = node.type === 'highlight' ? 3 : 1;

            let washPrompt: any = await getWashPrompt({
                nodeType: node.type,
                nodeId: node.id,
                nodeDescription: node.description,
                chapterContent,
                previousContext: '',
                globalMemory,
                language: config.novelLanguage as 'cn' | 'en',
            });

            const content = await chatWithRetry(washPrompt, {
                model: resolvedModel,
                maxTokens: TOKEN_LIMITS.writer,
            });

            const cleanedContent = cleanMarkdownCodeBlock(content);

            // Optional Stage 1.5: post-processing character renaming
            const shouldRemap = remapCharactersEnabled && Object.keys(characterMap || {}).length > 0;
            let finalContent = cleanedContent;

            if (shouldRemap) {
                await publishEvent(channel, {
                    type: 'thought',
                    message: tr(
                        `[Rename] 正在根据角色映射表重写节点 #${node.id} 的名字…`,
                        `[Rename] Applying character rename pipeline for node #${node.id}…`
                    ),
                    data: { nodeId: node.id, characterMapSize: Object.keys(characterMap || {}).length },
                });

                try {
                    const renamePrompt = await getRenameNodePrompt({
                        nodeId: node.id,
                        originalContent: cleanedContent,
                        characterMapJson: JSON.stringify(characterMap, null, 2),
                        language: config.novelLanguage as 'cn' | 'en',
                    });

                    const renamed = await chatWithRetry(renamePrompt, {
                        model: getModel('chat'),
                        maxTokens: TOKEN_LIMITS.writer,
                    });

                    finalContent = cleanMarkdownCodeBlock(renamed);

                    await publishEvent(channel, {
                        type: 'thought',
                        message: tr(
                            `[Rename] LLM 改名完成，继续进行字符串精修替换…`,
                            `[Rename] LLM rename pass complete, applying string-level fallback…`
                        ),
                        data: { nodeId: node.id },
                    });
                } catch (renameError) {
                    console.warn('Character rename LLM pass failed, falling back to string replacement only:', renameError);
                    await publishEvent(channel, {
                        type: 'log',
                        message: tr(
                            `[Rename] LLM 改名失败，改为只使用字符串替换兜底。`,
                            `[Rename] LLM rename failed, falling back to string replacement only.`,
                        ),
                        data: { nodeId: node.id },
                    });
                }

                // Always apply regex / substring-based replacement as a final safety net
                finalContent = applyCharacterMapStringReplace(finalContent, characterMap, config.novelLanguage as 'cn' | 'en');
            }

            await publishEvent(channel, {
                type: 'thought',
                message: tr(
                    `[Writer] 节点 #${node.id} 生成完成，${finalContent.length} 字。更新记忆中...`,
                    `[Writer] Node #${node.id} complete. ${finalContent.length} chars. Updating memory...`
                ),
                data: { nodeId: node.id, contentLength: finalContent.length },
            });

            // Stage 2: Update memory
            await publishEvent(channel, {
                type: 'thought',
                message: `[Memory] [Node ${node.id}] Stage 2: Updating global memory...`,
                data: { nodeId: node.id },
            });

            const memoryPrompt = await getMemoryPrompt({
                nodeContent: finalContent.slice(0, 3000),
                previousMemory: globalMemory,
                language: config.novelLanguage as 'cn' | 'en',
            });

            try {
                const newMemory = await chatWithRetry(memoryPrompt, {
                    model: getModel('chat'), // Use faster model for memory
                    maxTokens: TOKEN_LIMITS.memory,
                });

                // Append new memory as a MemoryLog record (append-only)
                await appendMemoryEntry({
                    sessionId,
                    nodeId: node.id,
                    content: newMemory,
                    type: 'summary',
                    importance: 2,
                });

                // Refresh sliding-window context for subsequent nodes
                globalMemory = await getMemoryContext(sessionId);

                await publishEvent(channel, {
                    type: 'thought',
                    message: tr(
                        `[Memory] 追加式记忆已更新 (节点 #${node.id})`,
                        `[Memory] Append-only memory updated (node #${node.id})`
                    ),
                    data: { nodeId: node.id },
                });
            } catch (memoryError) {
                console.warn('Memory update failed, keeping previous memory context:', memoryError);
            }

            // Update node and session atomically
            nodes[String(node.id)] = {
                ...nodes[String(node.id)],
                content: finalContent,
                status: 'completed',
            };

            // Use transaction to ensure atomic updates
            await prisma.$transaction(async (tx) => {
                await tx.session.update({
                    where: { id: sessionId },
                    data: {
                        nodes,
                        globalMemory,
                    },
                });

                await tx.task.update({
                    where: { id: taskId },
                    data: {
                        progress: Math.floor((generatedCount / total) * 100),
                        context: { currentNode: node.id, globalMemory },
                    },
                });
            });

            await publishEvent(channel, {
                type: 'node_ready',
                message: `Node ${node.id} generated`,
                data: { nodeId: node.id, content: finalContent },
            });

            // Trigger Auto-Review if enabled
            if (job.data.autoReview) {
                await publishEvent(channel, {
                    type: 'thought',
                    message: `Auto-review enabled. Sending node ${node.id} for review...`,
                });
                const { queues } = await import('../lib/queue.js');
                await queues.reviewing.add('auto-review', {
                    sessionId,
                    taskId, // Use same taskId to keep event stream unified
                    nodeId: node.id,
                    autoFix: true,
                });
            }

            generatedCount++;

        } catch (error) {
            console.error(`Error generating node ${node.id}:`, error);

            nodes[String(node.id)] = {
                ...nodes[String(node.id)],
                status: 'error',
            };

            await prisma.session.update({
                where: { id: sessionId },
                data: { nodes },
            });

            await publishEvent(channel, {
                type: 'error',
                message: `Error generating node ${node.id}: ${error}`,
                data: { nodeId: node.id, error: String(error) },
            });
        }
    }

    // Update session status
    await prisma.session.update({
        where: { id: sessionId },
        data: { status: 'completed' },
    });

    // Complete task
    await prisma.task.update({
        where: { id: taskId },
        data: {
            status: 'completed',
            progress: 100,
            result: { generatedCount, total },
        },
    });

    await publishEvent(channel, {
        type: 'complete',
        message: `Generation complete! ${generatedCount}/${total} nodes generated.`,
        data: { generatedCount, total },
    });
}
