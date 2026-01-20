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
} from '../lib/json-utils.js';
import { Chapter } from '../schemas/session.js';
import { Node as JsonNode } from '../schemas/node.js';
import { config } from '../config/index.js';
import { getBranchPlanPrompt, getBranchEventsPrompt, getBranchWritePrompt, getRenameNodePrompt } from '../lib/langfuse.js';
import { isCn } from '../lib/i18n.js';
import { buildChapterContent } from '../lib/chapter-utils.js';
import { applyCharacterMapStringReplace } from '../lib/character-utils.js';

interface BranchPlanItem {
  type: 'divergent' | 'convergent';
  fromNodeId: number;
  returnNodeId?: number | null;
  summary: string;
}

interface BranchEventPlanItem {
  eventId: number;
  anchorMainNodeId: number;
  title: string;
  summary: string;
  notes?: string;
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
  const characterMap = parseJsonField<Record<string, string>>(
    // characterMap may be stored as JSON or string; normalize here
    (session as any).characterMap ?? {},
    {},
  );
  const contentAnalysis = parseJsonField<Record<string, any>>(
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
    targetDivergent: config.business.targetDivergentBranches,
    targetConvergent: config.business.targetConvergentBranches,
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
    message: `[Brancher] Planned ${planItems.length} branches. Planning per-branch events and generating branch nodes...`,
  });

  // Determine next node id for JSON/Node table
  const existingIds = Object.keys(nodesJson).map((k) => Number(k)).filter((n) => Number.isFinite(n));
  let nextId = existingIds.length ? Math.max(...existingIds) + 1 : 1;

  // Helper: build a compact main-context string focused on a window of main nodes
  function buildMainContextAround(fromNodeId: number, returnNodeId?: number | null): string {
    const windowSize = 3; // fromNodeId 前后各取若干个节点，给事件规划足够上下文
    const indices = mainNodesDb.map(n => n.nodeIndex).sort((a, b) => a - b);
    const fromIdx = indices.indexOf(fromNodeId);
    if (fromIdx === -1) return mainSummary;

    const startIdx = Math.max(0, fromIdx - windowSize);
    let endIdx = Math.min(indices.length - 1, fromIdx + windowSize);

    // 对 convergent 支线，尽量把 returnNodeId 附近也包含进来
    if (returnNodeId && indices.includes(returnNodeId)) {
      const retIdx = indices.indexOf(returnNodeId);
      endIdx = Math.max(endIdx, Math.min(indices.length - 1, retIdx + 1));
    }

    const slice = indices.slice(startIdx, endIdx + 1);
    return slice
      .map((idx) => {
        const dbNode = mainNodesDb.find((n) => n.nodeIndex === idx);
        const jsonNode = nodesJson[String(idx)] as JsonNode | undefined;
        if (!dbNode || !jsonNode) return '';
        const label = jsonNode.description || dbNode.description || '';
        const snippet = (jsonNode.content || dbNode.content || '').slice(0, 300).replace(/\s+/g, ' ');
        return `Node ${idx}: ${label}\n  Snippet: ${snippet}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }

  for (const item of planItems) {
    const fromNodeId = item.fromNodeId;
    const fromDb = mainNodesDb.find((n) => n.nodeIndex === fromNodeId);
    const fromJson = nodesJson[String(fromNodeId)] as JsonNode | undefined;
    if (!fromDb || !fromJson) continue;

    const baseBranchSummary = item.summary || fromJson.description || '';

    // ---------- Stage B: per-branch event planning ----------
    const mainContext = buildMainContextAround(fromNodeId, item.returnNodeId ?? undefined) || mainSummary;

    await publishEvent(channel, {
      type: 'thought',
      message: `[Brancher] Planning events for ${item.type} branch from main node #${fromNodeId}...`,
      data: { fromNodeId, type: item.type },
    });

    const minEvents = 3;
    const maxEvents = 8;

    let branchEvents: BranchEventPlanItem[] = [];
    try {
      const eventsPrompt = await getBranchEventsPrompt({
        fromNodeId,
        returnNodeId: item.returnNodeId ?? null,
        branchType: item.type,
        branchSummary: baseBranchSummary,
        mainContext,
        minEvents,
        maxEvents,
        language: config.novelLanguage,
      });

      const rawEvents = await chatWithRetry(eventsPrompt, {
        model: resolvedModel,
        maxTokens: TOKEN_LIMITS.planner,
      });

      const parsed = parseJsonLoose(rawEvents);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.events) ? (parsed as any).events : [];

      branchEvents = arr
        .map((e: any, idx: number) => ({
          eventId: Number(e.eventId ?? idx + 1),
          anchorMainNodeId: Number(e.anchorMainNodeId ?? fromNodeId),
          title: String(e.title ?? '').trim() || `Event ${idx + 1}`,
          summary: String(e.summary ?? '').trim() || baseBranchSummary,
          notes: e.notes ? String(e.notes) : undefined,
        }))
        .filter((e: BranchEventPlanItem) => Number.isFinite(e.anchorMainNodeId));
    } catch (e) {
      console.warn('[Brancher] Failed to plan events for branch, falling back to single event:', e);
    }

    if (!branchEvents.length) {
      branchEvents = [
        {
          eventId: 1,
          anchorMainNodeId: fromNodeId,
          title: baseBranchSummary || `Branch from node #${fromNodeId}`,
          summary: baseBranchSummary || 'Auto-generated branch event',
        },
      ];
    }

    await publishEvent(channel, {
      type: 'thought',
      message: `[Brancher] Planned ${branchEvents.length} events for branch from node #${fromNodeId}. Generating nodes...`,
      data: { fromNodeId, type: item.type, eventCount: branchEvents.length },
    });

    // ---------- Stage C: per-event node generation ----------
    for (let idx = 0; idx < branchEvents.length; idx++) {
      const event = branchEvents[idx];
      const isLast = idx === branchEvents.length - 1;

      const anchorDb = mainNodesDb.find((n) => n.nodeIndex === event.anchorMainNodeId) || fromDb;
      const anchorJson = (nodesJson[String(event.anchorMainNodeId)] as JsonNode | undefined) || fromJson;

      const chapterContent = buildChapterContent(
        chapters,
        anchorJson?.startChapter ?? fromJson.startChapter,
        anchorJson?.endChapter ?? fromJson.endChapter,
      );

      const mainSnippetParts: string[] = [];
      if (anchorJson?.description || anchorDb?.description) {
        mainSnippetParts.push(String(anchorJson?.description || anchorDb?.description));
      }
      if (item.type === 'convergent' && item.returnNodeId) {
        const retJson = nodesJson[String(item.returnNodeId)] as JsonNode | undefined;
        if (retJson?.content) {
          const retSnippet = String(retJson.content).split(/\n\n+/)[0].slice(0, 400);
          mainSnippetParts.push(`(Target return point snippet)\n${retSnippet}`);
        }
      }
      mainSnippetParts.push(chapterContent.slice(0, 2000));
      const mainSnippet = mainSnippetParts.join('\n\n');

      const eventDescription = `${baseBranchSummary ? `${baseBranchSummary} · ` : ''}${event.title}`;

      const branchModel = getModel(MODEL_ROUTER.writer);
      const writePrompt = await getBranchWritePrompt({
        fromNodeId,
        baseDescription: eventDescription,
        mainSnippet,
        branchType: item.type,
        returnSnippet: undefined,
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
          message: `[Brancher] Applying character rename pipeline for branch event ${event.eventId} from main node #${fromNodeId}…`,
          data: { fromNodeId, eventId: event.eventId, characterMapSize: Object.keys(characterMap || {}).length },
        });

        try {
          const renamePrompt = await getRenameNodePrompt({
            nodeId: fromNodeId,
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

      const branchNodeId = nextId++;
      const dbNodeType = isLast ? 'branch_end' : 'branch_body';

      // Persist in Prisma Node table
      await prisma.node.create({
        data: {
          sessionId,
          type: dbNodeType,
          nodeIndex: branchNodeId,
          title: event.title.slice(0, 50) || baseBranchSummary.slice(0, 50),
          description: eventDescription,
          content: finalContent,
          startChapter: anchorJson?.startChapter ?? fromJson.startChapter ?? null,
          endChapter: anchorJson?.endChapter ?? fromJson.endChapter ?? null,
          parentId: fromNodeId,
          returnToNodeId:
            isLast && item.type === 'convergent' && item.returnNodeId
              ? item.returnNodeId
              : null,
          branchReason: baseBranchSummary,
          status: 'completed',
          qualityScore: null,
        },
      });

      // Update Session.nodes JSON so frontend can see the branch immediately.
      nodesJson[String(branchNodeId)] = {
        id: branchNodeId,
        type: fromJson.type, // reuse highlight/normal classification for UI
        startChapter: anchorJson?.startChapter ?? fromJson.startChapter,
        endChapter: anchorJson?.endChapter ?? fromJson.endChapter,
        description: eventDescription,
        content: finalContent,
        status: 'completed',
        createdAt: new Date().toISOString(),
        // Branch metadata for frontend
        branchKind: item.type,
        parentNodeId: fromNodeId,
        returnToNodeId:
          isLast && item.type === 'convergent' && item.returnNodeId
            ? item.returnNodeId
            : null,
        branchEventId: event.eventId,
      } as any;

      // Persist incrementally so that already generated branches are durable
      // even if the worker crashes mid-job.
      await prisma.session.update({
        where: { id: sessionId },
        data: { nodes: nodesJson },
      });

      await publishEvent(channel, {
        type: 'log',
        message: `[Brancher] Generated branch node #${branchNodeId} for event ${event.eventId}/${branchEvents.length} from main node #${fromNodeId} (${item.type})`,
        data: {
          branchId: branchNodeId,
          fromNodeId,
          type: item.type,
          eventId: event.eventId,
          eventIndex: idx,
        },
      });
    }
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
