/**
 * Branching Worker
 * Plan and generate auto branches after main line is complete
 */
import { Job } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { publishEvent, channels } from '../lib/redis.js';
import { chatWithRetry, getModel, MODEL_ROUTER, TOKEN_LIMITS } from '../lib/llm.js';
import { BranchingJobData } from '../lib/queue.js';
import {
  parseJsonField,
  parseJsonLoose,
  cleanMarkdownCodeBlock,
  parseJsonField as parseJsonFieldLoose,
} from '../lib/json-utils.js';
import { Chapter } from '../schemas/session.js';
import { Node as JsonNode } from '../schemas/node.js';
import { config } from '../config/index.js';
import { getBranchPlanPrompt, getBranchWritePrompt, getRenameNodePrompt } from '../lib/langfuse.js';

const isCn = () => config.novelLanguage === 'cn';

interface BranchPlanItem {
  type: 'divergent' | 'convergent';
  fromNodeId: number;
  returnNodeId?: number | null;
  summary: string;
}

export async function processBranchingJob(job: Job<BranchingJobData>): Promise<void> {
  const { sessionId, taskId, model } = job.data;
  const channel = channels.jobEvents(taskId);

  console.log(`\n🌿 [Brancher] Starting branching job for session: ${sessionId.slice(0, 8)}...`);

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new Error('Session not found');
  }

  if (session.status !== 'completed') {
    throw new Error('Session must be completed before branching');
  }

  const chapters = parseJsonField<Record<string, Chapter>>(session.chapters, {});
  const nodesJson = parseJsonField<Record<string, JsonNode>>(session.nodes, {});
  const characterMap = parseJsonFieldLoose<Record<string, string>>(
    // characterMap may be stored as JSON or string; normalize here
    (session as any).characterMap ?? {},
    {},
  );
  const contentAnalysis = parseJsonFieldLoose<Record<string, any>>(
    (session as any).contentAnalysis ?? {},
    {},
  );
  const remapCharacters = !!contentAnalysis.remapCharacters;

  const mainNodesDb = await prisma.node.findMany({
    where: { sessionId, type: 'main' },
    orderBy: { nodeIndex: 'asc' },
  });

  if (!mainNodesDb.length) {
    throw new Error('No main-line nodes found for branching');
  }

  await publishEvent(channel, {
    type: 'thought',
    message: `[Brancher] Loaded ${mainNodesDb.length} main-line nodes, planning branches...`,
    data: { sessionId },
  });

  // Build a compact summary of the main line for the planner
  const mainSummary = mainNodesDb
    .map((n) => {
      const jsonNode = nodesJson[String(n.nodeIndex)] as JsonNode | undefined;
      const label = jsonNode?.description || n.description || '';
      const snippet = (jsonNode?.content || n.content || '').slice(0, 200).replace(/\s+/g, ' ');
      return `Node ${n.nodeIndex}: ${label}\n  Snippet: ${snippet}`;
    })
    .join('\n\n');

  // Ask Langfuse-managed branch planner to design divergent/convergent branches
  const resolvedModel = model ?? getModel(MODEL_ROUTER.planner);
  const planPrompt = await getBranchPlanPrompt({
    mainSummary,
    targetDivergent: 2,
    targetConvergent: 3,
    language: config.novelLanguage,
  });

  const rawPlan = await chatWithRetry(planPrompt, {
    model: resolvedModel,
    maxTokens: TOKEN_LIMITS.planner,
  });

  let planItems: BranchPlanItem[] = [];
  try {
    const parsed = parseJsonLoose(rawPlan);
    const branches = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray((parsed as any).branches)
        ? (parsed as any).branches
        : [];

    const divergent = branches.filter((b: any) => String(b.type).toLowerCase() === 'divergent');
    const convergent = branches.filter((b: any) => String(b.type).toLowerCase() === 'convergent');

    const pick = (arr: any[], count: number) => arr.slice(0, Math.max(0, Math.min(count, arr.length)));

    const selected: any[] = [
      ...pick(divergent, 2),
      ...pick(convergent, 3),
    ];

    planItems = selected.map((b) => ({
      type: (String(b.type).toLowerCase() === 'divergent' ? 'divergent' : 'convergent') as 'divergent' | 'convergent',
      fromNodeId: Number(b.fromNodeId),
      returnNodeId: b.returnNodeId != null ? Number(b.returnNodeId) : null,
      summary: String(b.summary ?? '').trim(),
    }));
  } catch (e) {
    console.error('[Brancher] Failed to parse branch plan JSON:', e);
  }

  if (!planItems.length) {
    throw new Error('Branch planning produced no branches');
  }

  await publishEvent(channel, {
    type: 'thought',
    message: `[Brancher] Planned ${planItems.length} branches. Generating branch content...`,
  });

  // Determine next node id for JSON/Node table
  const existingIds = Object.keys(nodesJson).map((k) => Number(k)).filter((n) => Number.isFinite(n));
  let nextId = existingIds.length ? Math.max(...existingIds) + 1 : 1;

  for (const item of planItems) {
    const fromNodeId = item.fromNodeId;
    const fromDb = mainNodesDb.find((n) => n.nodeIndex === fromNodeId);
    const fromJson = nodesJson[String(fromNodeId)] as JsonNode | undefined;
    if (!fromDb || !fromJson) continue;

    const branchId = nextId++;
    const branchType = 'branch_end'; // single-node branch for now

    const chapterContent = buildChapterContent(
      chapters,
      fromJson.startChapter,
      fromJson.endChapter,
    );

    const baseDescription = item.summary || fromJson.description || '';

    const mainSnippet = `${fromJson.description}\n\n${chapterContent.slice(0, 2000)}`;

    let returnSnippet: string | undefined;
    if (item.type === 'convergent' && item.returnNodeId) {
      const retJson = nodesJson[String(item.returnNodeId)] as JsonNode | undefined;
      if (retJson?.content) {
        returnSnippet = String(retJson.content).split(/\n\n+/)[0].slice(0, 400);
      }
    }

    const branchModel = getModel(MODEL_ROUTER.writer);
    const writePrompt = await getBranchWritePrompt({
      fromNodeId,
      baseDescription,
      mainSnippet,
      branchType: item.type,
      returnSnippet,
      language: config.novelLanguage,
    });

    const rawContent = await chatWithRetry(writePrompt, {
      model: branchModel,
      maxTokens: TOKEN_LIMITS.writer,
    });

    const cleanedContent = cleanMarkdownCodeBlock(rawContent);

    // Optional: apply the same post-processing rename pipeline as main-line
    // writer when remapCharacters is enabled and we have a characterMap.
    let finalContent = cleanedContent;
    const shouldRemap = remapCharacters && Object.keys(characterMap || {}).length > 0;

    if (shouldRemap) {
      await publishEvent(channel, {
        type: 'thought',
        message: `[Brancher] Applying character rename pipeline for branch node #${branchId}…`,
        data: { branchId, characterMapSize: Object.keys(characterMap || {}).length },
      });

      try {
        const renamePrompt = await getRenameNodePrompt({
          nodeId: branchId,
          originalContent: cleanedContent,
          characterMapJson: JSON.stringify(characterMap, null, 2),
          language: config.novelLanguage as 'cn' | 'en',
        });

        const renamed = await chatWithRetry(renamePrompt, {
          model: getModel('chat'),
          maxTokens: TOKEN_LIMITS.writer,
        });

        finalContent = cleanMarkdownCodeBlock(renamed);
      } catch (renameError) {
        console.warn('[Brancher] Character rename LLM pass failed, falling back to string replacement only:', renameError);
      }

      // String-level fallback, mirroring writer.ts
      finalContent = applyCharacterMapStringReplace(
        finalContent,
        characterMap,
        config.novelLanguage as 'cn' | 'en',
      );
    }

    // Persist in Prisma Node table
    await prisma.node.create({
      data: {
        sessionId,
        type: branchType,
        nodeIndex: branchId,
        title: baseDescription.slice(0, 50),
        description: baseDescription,
        content: finalContent,
        startChapter: fromJson.startChapter ?? null,
        endChapter: fromJson.endChapter ?? null,
        parentId: fromNodeId,
        returnToNodeId: item.type === 'convergent' && item.returnNodeId ? item.returnNodeId : null,
        branchReason: baseDescription,
        status: 'completed',
        qualityScore: null,
      },
    });

    // Update Session.nodes JSON so frontend can see the branch immediately.
    // We include lightweight branch metadata for UI purposes. These extra fields
    // are safe: backend parsers that use Zod NodeSchema will strip them.
    nodesJson[String(branchId)] = {
      id: branchId,
      type: fromJson.type, // reuse highlight/normal classification for UI
      startChapter: fromJson.startChapter,
      endChapter: fromJson.endChapter,
      description: baseDescription,
      content: finalContent,
      status: 'completed',
      createdAt: new Date().toISOString(),
      // Branch metadata for frontend
      branchKind: item.type,
      parentNodeId: fromNodeId,
      returnToNodeId: item.type === 'convergent' && item.returnNodeId ? item.returnNodeId : null,
    } as any;

    // Persist incrementally so that already generated branches are durable
    // even if the worker crashes mid-job.
    await prisma.session.update({
      where: { id: sessionId },
      data: { nodes: nodesJson },
    });

    await publishEvent(channel, {
      type: 'log',
      message: `[Brancher] Generated branch node #${branchId} from main node #${fromNodeId} (${item.type})`,
      data: { branchId, fromNodeId, type: item.type },
    });
  }

  // Final save (mostly redundant now, but harmless)
  await prisma.session.update({
    where: { id: sessionId },
    data: { nodes: nodesJson },
  });

  await publishEvent(channel, {
    type: 'complete',
    message: '[Brancher] Auto-branching complete.',
  });
}

// String-level fallback for character renaming (mirrors writer.ts)
function applyCharacterMapStringReplace(
  content: string,
  characterMap: Record<string, string>,
  language: 'cn' | 'en',
): string {
  if (!characterMap || !Object.keys(characterMap).length) return content;

  const entries = Object.entries(characterMap).sort((a, b) => b[0].length - a[0].length);

  let result = content;
  for (const [oldName, newName] of entries) {
    if (!oldName || !newName) continue;
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = language === 'en'
      ? new RegExp(`\\b${escaped}\\b`, 'g')
      : new RegExp(escaped, 'g');
    result = result.replace(pattern, newName);
  }

  return result;
}

// Reuse chapter content builder from writer
function buildChapterContent(
  chapters: Record<string, Chapter>,
  startChapter: number,
  endChapter: number,
): string {
  const blocks: string[] = [];

  for (let i = startChapter; i <= endChapter; i++) {
    const chapter = chapters[String(i)];
    if (chapter) {
      const header = isCn()
        ? `--- 第 ${chapter.number} 章: ${chapter.title} ---`
        : `--- Chapter ${chapter.number}: ${chapter.title} ---`;
      blocks.push(`${header}\n${chapter.content}`);
    }
  }

  return blocks.join('\n\n');
}
