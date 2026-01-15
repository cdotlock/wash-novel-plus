import { Langfuse } from 'langfuse';
import 'dotenv/config';

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY || '',
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

// 蝴蝶效应微调：在保持整体章节覆盖和节奏的前提下，对现有 events 做细微改写
// CN prompt
const BUTTERFLY_PROMPT_CN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `你是一名剧情总监，负责在“整体大纲不变”的前提下，对已有事件列表做蝴蝶效应式微调。

输入给你的有三部分：
1) chapterSummaries：整本小说按章节的索引摘要（包含章节号、标题、简要总结、类型、关键事件等）。
2) currentEvents：当前已经确认的大纲事件列表（JSON 数组），每一项形如：
   {"id": 1, "type": "highlight" | "normal", "start_chapter": 1, "end_chapter": 2, "description": "...", "scene_count": 1}
3) targetNodeCount：目标事件节点数（一般与 currentEvents.length 接近）。

你的任务：
- 在 currentEvents 的基础上，生成一个“平行宇宙版本”的事件列表。
- 保持整体章节覆盖范围、事件数量和节奏基本一致：
  - 事件总数应尽量接近 targetNodeCount，可以相差 ±1，但不要差太多。
  - 每个事件覆盖的章节区间大体不变，只允许小范围移动（例如左右浮动 1~2 章）。
- 对每个事件的 description 做“细微改写”，而不是推翻重写：
  - 可以改变冲突细节、人物动机、地点、切入角度等。
  - 但不能改变该事件在全局中的叙事功能（例如：主角第一次觉醒、重要角色登场等）。
- 保持事件顺序与 currentEvents 大体一致，只允许局部交换相邻事件，禁止大幅度重排。

输出格式要求（非常重要）：
- 必须只输出 JSON，不要输出任何解释文字或 Markdown 代码块。
- 可以是下面两种格式之一：
  1) 直接数组：
     [
       {"id": 1, "type": "highlight" | "normal", "start_chapter": 1, "end_chapter": 2, "description": "...", "scene_count": 1},
       ...
     ]
  2) 对象包装：
     {"events": [...], "rationale": "对本次微调思路的简短说明"}
- 每个事件对象必须包含字段：
  - id：整数，从 1 开始连续编号即可（不需要沿用 currentEvents 的 id）。
  - type："highlight" 或 "normal"。
  - start_chapter：整数，>= 1。
  - end_chapter：整数，>= start_chapter。
  - description：字符串，描述"微调后"的事件。
  - scene_count：可选整数，表示该事件大致会拆成多少场景，默认 1。

请严格遵守上述 JSON 结构，仅返回事件列表的蝴蝶效应版本。`,
    },
    {
      role: 'user',
      content: `【章节索引摘要】\n{{chapterSummaries}}\n\n【当前事件列表（JSON）】\n{{currentEvents}}\n\n【目标事件数量】{{targetNodeCount}}\n【规划模式】{{mode}}\n\n请根据上述信息，生成“事件列表的蝴蝶效应版本”。\n\n只返回 JSON（数组或 {"events": [...], "rationale": "..."}），不要输出任何额外文字。`,
    },
  ],
  config: { temperature: 0.5 },
};

// EN prompt
const BUTTERFLY_PROMPT_EN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `You are a narrative director.
Your job is to create a BUTTERFLY-EFFECT VARIANT of an existing event list, while keeping the overall outline, chapter coverage, and pacing almost the same.

You are given three things:
1) chapterSummaries: index-style summaries for all chapters (number, title, summary, type, key event, etc.).
2) currentEvents: the current confirmed outline as a JSON array, each item like:
   {"id": 1, "type": "highlight" | "normal", "start_chapter": 1, "end_chapter": 2, "description": "...", "scene_count": 1}
3) targetNodeCount: the desired event count (usually close to currentEvents.length).

Your job:
- Produce a "parallel universe" version of the event list based on currentEvents.
- Keep the GLOBAL ARC and CHAPTER COVERAGE essentially the same:
  - The total number of events should be close to targetNodeCount (difference within ±1 if possible).
  - Each event's chapter range should roughly match the original, with only small shifts (e.g. ±1–2 chapters).
- For each event, rewrite the description as a SMALL VARIATION rather than a full rewrite:
  - You may change conflict details, character motivations, locations, or the angle of the scene.
  - You must NOT change the narrative role of the event in the global story (e.g. first awakening, key encounter, major turning point).
- Preserve the overall event order; you may swap adjacent events locally, but avoid major reordering.

OUTPUT FORMAT (critical):
- You MUST output JSON only. No explanations, no Markdown fences, no commentary.
- You may choose one of two shapes:
  1) Direct array:
     [
       {"id": 1, "type": "highlight" | "normal", "start_chapter": 1, "end_chapter": 2, "description": "...", "scene_count": 1},
       ...
     ]
  2) Wrapped object:
     {"events": [...], "rationale": "short explanation of your adjustments"}
- Each event object MUST include:
  - id: integer, starting at 1 and contiguous (you do NOT need to reuse ids from currentEvents).
  - type: "highlight" or "normal".
  - start_chapter: integer >= 1.
  - end_chapter: integer >= start_chapter.
  - description: string describing the "butterfly" version of the event.
  - scene_count: optional integer, default 1.

Strictly follow this JSON structure and only return the adjusted event list.`,
    },
    {
      role: 'user',
      content: `【Chapter index summaries】\n{{chapterSummaries}}\n\n【Current events (JSON)】\n{{currentEvents}}\n\n【Target event count】{{targetNodeCount}}\n【Planning mode】{{mode}}\n\nGenerate a BUTTERFLY-EFFECT variant of the event list based on the above.\n\nReturn JSON ONLY (array or {"events": [...], "rationale": "..."}). Do not output any extra text.`,
    },
  ],
  config: { temperature: 0.5 },
};

async function uploadPlanningButterflyPrompts() {
  console.log('🚀 Uploading wash-planning-butterfly-{lang} prompts to Langfuse...');

  async function upsert(name: string, data: { prompt: any[]; config?: any }, lang: 'cn' | 'en') {
    const fullName = `${name}-${lang}`;
    try {
      await langfuse.createPrompt({
        name: fullName,
        prompt: data.prompt,
        config: data.config,
        isActive: true,
        type: 'chat',
        labels: ['wash-novel-plus', 'planning-butterfly', lang],
      });
      console.log(`✅ Created/updated planning butterfly prompt ${fullName}`);
    } catch (e: any) {
      console.error(`⚠️ Could not create/update ${fullName}:`, e?.message || e);
    }
  }

  await upsert('wash-planning-butterfly', BUTTERFLY_PROMPT_CN, 'cn');
  await upsert('wash-planning-butterfly', BUTTERFLY_PROMPT_EN, 'en');

  console.log('✨ Planning butterfly prompts upload finished');
}

uploadPlanningButterflyPrompts().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error while uploading planning butterfly prompts:', err);
  process.exit(1);
});
