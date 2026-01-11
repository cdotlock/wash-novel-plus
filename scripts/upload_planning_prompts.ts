import { Langfuse } from 'langfuse';
import 'dotenv/config';

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY || '',
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

// 仅规划相关的 Prompts（中文）
const PLANNING_PROMPTS_CN: Record<string, { prompt: any[]; config?: Record<string, unknown> }> = {
  'wash-planning-auto': {
    type: 'chat',
    prompt: [
      {
        role: 'system',
        content: `你是一个资深的游戏剧情策划。请根据小说章节摘要，规划出适合改编为互动游戏的事件节点。
你的任务：
1. 在内部选择【拆分模式（SPLIT）】或【合并模式（MERGE）】，但最终输出统一的 JSON 结构。
2. 覆盖所有章节（无缺口），节点顺序与章节时间线一致，id 从 1 开始连续递增。
3. 事件类型：
   - highlight：去掉该事件，故事主线或角色命运会断裂。
   - normal：为高光事件提供铺垫/过渡/信息获取。
4. 节奏：Normal:Highlight ≈ 5:3，可以略有浮动，但避免全是高光或全是日常。
5. 目标节点数：{{targetNodeCount}}（如未提供，可根据章节数和内容自行估算），最终节点数应控制在目标 ±15% 范围内。
6. 不要产生章节空洞：从最小章节号到最大章节号，每一章至少属于一个节点。

【输出要求（极其重要）】
只输出 JSON，不能有 Markdown 代码块或多余解释。
允许两种合法结构之一：
1) 直接输出数组：
[
  { "id": 1, "type": "normal" | "highlight", "start_chapter": 1, "end_chapter": 2, "description": "...", "scene_count": 1 }
]
2) 对象形式：
{
  "events": [ { ... 同上 ... } ],
  "rationale": "简要说明你的整体规划思路、采用的模式以及如何满足目标节点数。"
}

每个事件字段说明：
- id：整数，从 1 开始连续编号。
- type："highlight" 或 "normal"。
- start_chapter / end_chapter：整型章节号，必须覆盖输入范围内的章节，并且 start_chapter <= end_chapter。
- description：用 1-3 句话概括该节点发生了什么，并解释为何被判定为 normal/highlight。
- scene_count：可选，场景子段数量（默认 1）。`,
      },
      {
        role: 'user',
        content: `下面是本次需要规划的章节索引（按章节顺序排列）：\n\n{{chapterSummaries}}`,
      },
    ],
    config: { temperature: 0.4 },
  },
  'wash-planning-split': {
    type: 'chat',
    prompt: [
      {
        role: 'system',
        content: `【拆分模式（SPLIT）】你是一个剧情策划，当前已确认使用拆分模式。
请将给定章节拆分为多个精细的事件节点：
1. 高光爆发点必须单独拆分为 Highlight 节点。
2. 地点/时间/视角强切、情绪强烈转折是天然拆分点。
3. Highlight 节点建议覆盖 1-3 章，Normal 节点建议覆盖 1-5 章，可根据摘要灵活调整。
4. 覆盖所有章节，不允许有遗漏或倒序。
5. 节点总数尽量接近 {{targetNodeCount}}（±15%）。
6. 输出 JSON 结构与 wash-planning-auto 完全一致，只能输出 JSON，不要 Markdown 代码块或其它解释。`,
      },
      {
        role: 'user',
        content: `章节摘要列表：\n{{chapterSummaries}}`,
      },
    ],
    config: { temperature: 0.4 },
  },
  'wash-planning-merge': {
    type: 'chat',
    prompt: [
      {
        role: 'system',
        content: `【合并模式（MERGE）】你是一个剧情策划，当前已确认使用合并模式。
请将给定章节合并为结构紧凑、节奏合理的事件节点：
1. 多章铺垫/赶路/日常相处，如服务于同一目标且无重大分歧，可合并成一个 Normal 节点。
2. 一场完整战斗/谈判/危机（起因-发展-高潮-收束）可合并为一个 Highlight 节点。
3. 保持地点/事件连续性的前提下尽量合并，避免将同一场冲突切成过多节点。
4. 覆盖所有章节，不允许遗漏或重复。
5. 节点总数尽量接近 {{targetNodeCount}}（±15%）。
6. 输出 JSON 结构与 wash-planning-auto 完全一致，只能输出 JSON，不要 Markdown 代码块或其它解释。`,
      },
      {
        role: 'user',
        content: `章节摘要列表：\n{{chapterSummaries}}`,
      },
    ],
    config: { temperature: 0.4 },
  },
  'wash-planning-adjust': {
    type: 'chat',
    prompt: [
      {
        role: 'system',
        content: `你是一个负责「二次规划」的剧情策划助手。
系统已经有了一版初始事件规划 currentEvents（JSON 数组），现在需要你在此基础上，
通过拆分/合并来尽量满足目标节点数 {{targetNodeCount}}，同时保持：
1. 覆盖的章节范围与原规划一致（不能跳过章节，也不能超出原始最小/最大章节号范围）。
2. 章节时间顺序不变，事件的时间线单向前进。
3. 事件类型判定与原规划大致一致：
   - 若原规划中将一个章节段落标为 highlight，除非有充分理由，不要随意全部降级为 normal。
4. 尽量重用原有事件的逻辑边界：
   - 合并：优先将相邻、类型相同且功能相近的节点合并。
   - 拆分：优先对跨度较大的节点进行拆分（可参考章节摘要中的情节转折点）。
5. 输出的事件总数应尽量等于 {{targetNodeCount}}，允许误差 ±15%。

请你仅基于以下输入：
- chapterSummaries：每章的编号、标题和摘要（按顺序）。
- currentEvents：当前规划的事件列表（JSON 数组）。

【输出要求】
只输出 JSON，不要 Markdown 代码块或多余解释。
输出结构与初次规划相同：
1) 可以直接输出事件数组：[ { ...事件... } ]；
2) 或输出对象：{ "events": [ ...事件... ], "rationale": "..." }。

每个事件对象必须包含：id, type, start_chapter, end_chapter, description, scene_count(可选)。`,
      },
      {
        role: 'user',
        content:
          `章节摘要（供参考）：\n{{chapterSummaries}}\n\n当前规划事件（JSON）：\n{{currentEvents}}`,
      },
    ],
    config: { temperature: 0.4 },
  },
};

// 仅规划相关的 Prompts（英文）
const PLANNING_PROMPTS_EN: Record<string, { prompt: any[]; config?: Record<string, unknown> }> = {
  'wash-planning-auto': {
    type: 'chat',
    prompt: [
      {
        role: 'system',
        content: `You are a senior game narrative designer. Based on the chapter summaries, plan a sequence of interactive event nodes.
Goals:
1. Internally decide whether SPLIT or MERGE strategy is better, but always output a unified JSON schema.
2. Cover ALL chapters with no gaps; node order must follow chapter chronology; ids are 1..N.
3. Event types:
   - highlight: removing this event would break the main plot or character arc.
   - normal: buildup / transition / information gathering.
4. Rhythm: Normal:Highlight ≈ 5:3 (approximate), avoid all-highlight or all-normal.
5. Target node count: {{targetNodeCount}} (if missing, infer a reasonable target from the chapters). Final count should be within ±15% of the target.
6. No chapter holes: from the minimum to the maximum chapter index, each chapter must belong to at least one event.

[OUTPUT REQUIREMENTS]
You MUST output ONLY raw JSON, with NO Markdown fences or commentary.
Valid JSON shapes:
1) Direct array of events: [ { "id": 1, "type": "normal" | "highlight", "start_chapter": 1, "end_chapter": 2, "description": "...", "scene_count": 1 } ]
2) Object: { "events": [ ... ], "rationale": "..." }

Each event object MUST include: id, type, start_chapter, end_chapter, description, scene_count(optional).`,
      },
      {
        role: 'user',
        content: `Here are the chapter summaries (in order):\n\n{{chapterSummaries}}`,
      },
    ],
    config: { temperature: 0.4 },
  },
  'wash-planning-split': {
    type: 'chat',
    prompt: [
      {
        role: 'system',
        content: `[SPLIT MODE] You are a narrative designer. The strategy is fixed to SPLIT.
Split the given chapters into fine-grained event nodes:
1. Conflict explosions must be isolated into highlight nodes.
2. Hard cuts in location/time/POV or strong emotional shifts are natural split points.
3. Highlight nodes usually span 1-3 chapters, normal nodes 1-5 chapters (flexible).
4. Cover all chapters with no gaps or reordering.
5. Keep total node count close to {{targetNodeCount}} (±15%).
6. Output JSON schema must match wash-planning-auto, with NO Markdown fences or extra commentary.`,
      },
      {
        role: 'user',
        content: `Chapter summaries:\n{{chapterSummaries}}`,
      },
    ],
    config: { temperature: 0.4 },
  },
  'wash-planning-merge': {
    type: 'chat',
    prompt: [
      {
        role: 'system',
        content: `[MERGE MODE] You are a narrative designer. The strategy is fixed to MERGE.
Merge the given chapters into compact, well-paced event nodes:
1. Multiple buildup/road-trip/daily-life chapters serving one goal may be merged into a normal node.
2. A complete battle/negotiation/crisis (setup->development->climax->resolution) may be merged into a highlight node.
3. Prefer merging as long as location and core event remain the same.
4. Cover all chapters with no gaps or reordering.
5. Keep total node count close to {{targetNodeCount}} (±15%).
6. Output JSON schema must match wash-planning-auto, with NO Markdown fences or extra commentary.`,
      },
      {
        role: 'user',
        content: `Chapter summaries:\n{{chapterSummaries}}`,
      },
    ],
    config: { temperature: 0.4 },
  },
  'wash-planning-adjust': {
    type: 'chat',
    prompt: [
      {
        role: 'system',
        content: `You are a narrative "second-pass" planner.
The system already has an initial planning result currentEvents (JSON array). Your job is to adjust it—by merging and/or splitting events—
so that the total number of events is as close as possible to targetNodeCount = {{targetNodeCount}}, while preserving:
1. Overall chapter coverage range (no new chapters outside the original min/max, no gaps).
2. Chronological order of events.
3. Roughly consistent type semantics (highlight vs normal) with the original plan, unless you have strong justification.
4. Prefer to reuse original logical boundaries: merge adjacent events with similar type/function; split wide-span events at natural turning points.

Input:
- chapterSummaries: textual summaries of each chapter (ordered).
- currentEvents: current planning events as a JSON array.

[OUTPUT REQUIREMENTS]
Output ONLY raw JSON, NO Markdown fences or commentary.
Allowed shapes:
1) Direct array of events: [ { ... } ]
2) Object: { "events": [ ... ], "rationale": "..." }

Each event MUST include: id, type, start_chapter, end_chapter, description, scene_count(optional).`,
      },
      {
        role: 'user',
        content:
          `Chapter summaries (for context):\n{{chapterSummaries}}\n\nCurrent planning events (JSON):\n{{currentEvents}}`,
      },
    ],
    config: { temperature: 0.4 },
  },
};

async function uploadPlanningPrompts() {
  console.log('🚀 Uploading planning prompts to Langfuse (CN/EN)...');

  // Helper to create a prompt if missing; log but do not abort on error
  async function upsertPlanningPrompt(name: string, langSuffix: 'cn' | 'en', data: { prompt: any[]; config?: any }) {
    const fullName = `${name}-${langSuffix}`;
    try {
      await langfuse.createPrompt({
        name: fullName,
        prompt: data.prompt,
        config: data.config,
        isActive: true,
        type: 'chat',
        labels: ['wash-novel-plus', 'planning', langSuffix],
      });
      console.log(`✅ Created planning prompt ${fullName}`);
    } catch (e: any) {
      // 如果已经存在，就只打印信息，不中断整个流程
      console.error(`⚠️ Could not create ${fullName}: ${e?.message || e}`);
    }
  }

  // CN
  for (const [name, data] of Object.entries(PLANNING_PROMPTS_CN)) {
    await upsertPlanningPrompt(name, 'cn', data as any);
  }

  // EN
  for (const [name, data] of Object.entries(PLANNING_PROMPTS_EN)) {
    await upsertPlanningPrompt(name, 'en', data as any);
  }

  console.log('✨ Planning prompts upload finished');
}

uploadPlanningPrompts().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error while uploading planning prompts:', err);
  process.exit(1);
});
