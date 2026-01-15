import { prisma } from './prisma.js';

interface MemoryWindowOptions {
  /** how many most recent records regardless of importance */
  recentLimit?: number;
  /** minimum importance for "important" memories */
  minImportant?: number;
  /** how many important memories (>= minImportant) to keep */
  importantLimit?: number;
}

const DEFAULT_WINDOW: Required<MemoryWindowOptions> = {
  recentLimit: 3,
  minImportant: 3,
  importantLimit: 10,
};

export async function getMemoryContext(
  sessionId: string,
  options: MemoryWindowOptions = {},
): Promise<string> {
  const { recentLimit, minImportant, importantLimit } = {
    ...DEFAULT_WINDOW,
    ...options,
  };

  // 1. recent N
  const recent = await prisma.memoryLog.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: recentLimit,
  });

  // 2. important, excluding ones we already took as recent
  const recentIds = new Set(recent.map((m) => m.id));
  const important = await prisma.memoryLog.findMany({
    where: {
      sessionId,
      importance: { gte: minImportant },
    },
    orderBy: { createdAt: 'desc' },
    take: importantLimit,
  });

  const merged = [...recent, ...important.filter((m) => !recentIds.has(m.id))]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  if (!merged.length) return '';

  return merged
    .map((m) => {
      const tag = m.type ?? 'memory';
      const imp = m.importance ?? 1;
      return `[${tag}#${imp}] ${m.content}`;
    })
    .join('\n');
}

export async function appendMemoryEntry(params: {
  sessionId: string;
  nodeId?: number;
  content: string;
  type?: string;
  importance?: number;
}): Promise<void> {
  const { sessionId, nodeId, content, type = 'summary', importance = 1 } = params;
  if (!content.trim()) return;

  await prisma.memoryLog.create({
    data: {
      sessionId,
      nodeId: nodeId ?? null,
      content,
      type,
      importance,
    },
  });
}
