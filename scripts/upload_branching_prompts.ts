import { Langfuse } from 'langfuse';
import 'dotenv/config';

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY || '',
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

// --- Branch planning prompt ---

const BRANCH_PLAN_CN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `你是一名游戏关卡 / 剧情设计师，负责在已经完成的主线剧情上设计少量“支线剧情”。

你将会得到：
- mainSummary：已经按照顺序整理好的主线节点列表，每条包含节点编号、简要说明和正文片段摘要。
- targetDivergent：需要生成的“独立结局型支线”数量（divergent）。
- targetConvergent：需要生成的“回归主线型支线”数量（convergent）。

支线类型定义：
- divergent：从某个主线节点分叉出去，走向完全不同的结局（可好可坏），不再回到主线。
- convergent：从某个主线节点分叉出去，经历一段支线后，必须在之后的某个主线节点“自然回归”。

你的任务：
1. 设计 EXACTLY (targetDivergent + targetConvergent) 条支线（通常是 2 条 divergent + 3 条 convergent）。
2. 每条支线用一个 JSON 对象表示，字段包括：
   - type: "divergent" | "convergent";
   - fromNodeId: 分叉的主线节点编号（整数）；
   - returnNodeId: 对于 convergent 支线，必须是一个 > fromNodeId 的主线节点编号；对于 divergent 可以为 null 或省略；
   - summary: 1~3 句话，描述该支线的核心冲突、变化点，以及对主线的意义。
3. 保证：
   - convergent 支线的 returnNodeId 一定大于 fromNodeId，并且逻辑上能“无缝接回”主线。
   - 尽量覆盖主线中节奏关键的节点，而不是全部集中在开头或结尾。

输出格式（非常重要）：
- 必须只输出 JSON，不要输出任何解释性文字或 Markdown 代码块。
- 可以是：
  1) 直接数组：
     [
       {"type": "divergent", "fromNodeId": 10, "summary": "..."},
       {"type": "convergent", "fromNodeId": 20, "returnNodeId": 22, "summary": "..."}
     ]
  2) 或对象包装：
     {"branches": [...]}。
- 请严格保证 divergent 和 convergent 的数量满足 targetDivergent 和 targetConvergent，否则视为失败。`,
    },
    {
      role: 'user',
      content: `【主线节点摘要】\n{{mainSummary}}\n\n【支线数量要求】\n- 独立结局支线 (divergent): {{targetDivergent}} 条\n- 回归主线支线 (convergent): {{targetConvergent}} 条\n\n请根据上述信息，返回一个 JSON（数组或 {"branches": [...]}），元素为 {"type","fromNodeId","returnNodeId?","summary"}。\n不要输出任何额外文字。`,
    },
  ],
  config: { temperature: 0.6 },
};

const BRANCH_PLAN_EN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `You are a game narrative designer. The main story line is already complete; your job is to design a small set of SIDE BRANCHES.

You will receive:
- mainSummary: an ordered list of main-line nodes, each with an index, a short description, and a snippet of text.
- targetDivergent: how many DIVERGENT branches to create.
- targetConvergent: how many CONVERGENT branches to create.

Branch types:
- divergent: leaves the main line at some node and leads to an alternative ending (good, bad, or secret), never returning to the main line.
- convergent: leaves the main line at some node, explores a detour, and MUST logically reconnect to a later main-line node.

Your job:
1. Design EXACTLY (targetDivergent + targetConvergent) branches (typically 2 divergent + 3 convergent).
2. Represent each branch as a JSON object with fields:
   - type: "divergent" | "convergent";
   - fromNodeId: main-line node index where this branch diverges (integer);
   - returnNodeId: for convergent branches, a main-line node index > fromNodeId where the branch naturally rejoins; for divergent branches, this may be null/omitted;
   - summary: 1–3 sentences describing what happens in this branch and why it matters.
3. Constraints:
   - For convergent branches, returnNodeId MUST be greater than fromNodeId and make narrative sense.
   - Try to cover structurally important parts of the main line, not only the very beginning or the very end.

OUTPUT FORMAT (critical):
- Output JSON ONLY. No explanations, no Markdown fences, no commentary.
- You may output either:
  1) a direct array:
     [
       {"type": "divergent", "fromNodeId": 10, "summary": "..."},
       {"type": "convergent", "fromNodeId": 20, "returnNodeId": 22, "summary": "..."}
     ]
  2) or a wrapped object:
     {"branches": [...]}.
- The counts of divergent and convergent branches MUST exactly match targetDivergent and targetConvergent.`,
    },
    {
      role: 'user',
      content: `【Main-line nodes (summary)】\n{{mainSummary}}\n\n【Branch count requirements】\n- Divergent branches: {{targetDivergent}}\n- Convergent branches: {{targetConvergent}}\n\nReturn JSON (array or {"branches": [...]}), where each element has {"type","fromNodeId","returnNodeId?","summary"}.\nDo NOT output any additional text.`,
    },
  ],
  config: { temperature: 0.6 },
};

// --- Branch writing prompt ---

const BRANCH_WRITE_CN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `你是一名擅长长篇叙事的游戏文本设计师，负责根据主线节点与支线设定，写出一段“支线剧情节点”的高质量完整文本（Markdown）。

你会得到：
- fromNodeId：主线节点编号；
- baseDescription：该支线的设定与概要（分支的核心冲突 / 情感 / 变奏点）；
- mainSnippet：主线对应片段的正文摘要或原文片段；
- branchType："divergent" 或 "convergent"；
- returnSnippet（仅当 branchType 为 convergent 提供）：回归主线节点开头的一小段原文片段。

写作总体要求：
- 叙事风格与主线保持一致（人称、语气、节奏、世界观设定）。
- 不要写成「提纲」或「流水账」，而是真正可直接游玩的剧情文本，具备细节描写和情绪起伏。
- 篇幅大致与普通主线节点相当，可以理解为：有完整的起承转合，主干剧情不少于 800～2000 字（根据语言自动调节），避免只有几句台词。

分支类型要求：
- 如果 branchType = "divergent"：
  - 让剧情从 mainSnippet 所描述的情境自然分叉出去，走向一个“完整但不同”的结局；
  - 不要再回到主线，结尾写成一个相对收束的结局（可以是 BE / 真结局 / 隐藏结局等），并强调与主线的命运差异。
- 如果 branchType = "convergent"：
  - 让剧情从 mainSnippet 分叉，经历一段在情节或情绪上有明显增量的支线；
  - 在分支末尾，自然地把人物 / 状态 / 场景「送回」 returnSnippet 所描述的开场状态；
  - 你可以在结尾用一两句过渡语句对齐 returnSnippet 的情绪或场景，但不要直接复制原文。

输出规范：
- 只输出 Markdown 文本（段落、对话、列表皆可），不要出现 JSON 或解释性文字；
- 不要使用 \`\`\` 代码块包裹全文。`,
    },
    {
      role: 'user',
      content: `【主线节点 ID】{{fromNodeId}}\n【支线类型】{{branchType}}\n【支线设定概要】{{baseDescription}}\n\n【主线原文片段 / 摘要】\n{{mainSnippet}}\n\n【回归主线片段（仅当为 convergent 时有效）】\n{{returnSnippet}}\n\n请写出对应的支线剧情节点文本（Markdown）。不要输出任何解释文字。`,
    },
  ],
  config: { temperature: 0.7 },
};

const BRANCH_WRITE_EN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `You are an experienced long-form game narrative writer. Based on a main-line node and a branch concept, you will write a SINGLE HIGH-QUALITY SIDE-BRANCH NODE in Markdown.

You will be given:
- fromNodeId: the id of the main-line node where this branch diverges;
- baseDescription: a short description of what this branch is about (core conflict / emotion / variation);
- mainSnippet: a snippet or summary of the corresponding main-line text segment;
- branchType: "divergent" or "convergent";
- returnSnippet (only when branchType = "convergent"): the first paragraph or a short snippet of the main-line node where the branch should rejoin.

General writing requirements:
- Match the tone, narrative voice, POV, and style of the main story.
- Do NOT write an outline or bullet-point summary; produce real, polished narrative prose with concrete details and emotional beats.
- Length: roughly comparable to a normal main-line node. Think of a complete scene arc with clear beginning, build-up, and resolution (often ~800–2000 words depending on language and pacing). Avoid ultra-short stubs.

Branch-type specific rules:
- If branchType = "divergent":
  - Let the story diverge naturally from the situation described in mainSnippet and lead to a DISTINCT alternative ending (good/bad/secret, etc.).
  - Do NOT return to the main line; end with a reasonably conclusive ending that highlights how this fate differs from the canonical route.
- If branchType = "convergent":
  - Let the story diverge from mainSnippet, explore a meaningful detour, then NATURALLY steer the characters/world back into the state suggested by returnSnippet.
  - You may echo the emotions/location/situation of returnSnippet at the end, but do not copy-paste the original text.

Output format:
- Output plain Markdown text only (paragraphs, dialogue, lists, etc.).
- Do NOT wrap the text in \`\`\` fences.
- Do NOT output JSON or any explanations.`,
    },
    {
      role: 'user',
      content: `【Main-line node ID】{{fromNodeId}}\n【Branch type】{{branchType}}\n【Branch concept】{{baseDescription}}\n\n【Main-line snippet / summary】\n{{mainSnippet}}\n\n【Return snippet (only meaningful for convergent)】\n{{returnSnippet}}\n\nWrite the side-branch node in Markdown. Do not output any explanations.`,
    },
  ],
  config: { temperature: 0.7 },
};

async function uploadBranchingPrompts() {
  console.log('🚀 Uploading wash-branch-{plan,write}-{lang} prompts to Langfuse...');

  async function upsert(name: string, data: { prompt: any[]; config?: any }, lang: 'cn' | 'en', labels: string[]) {
    const fullName = `${name}-${lang}`;
    try {
      await langfuse.createPrompt({
        name: fullName,
        prompt: data.prompt,
        config: data.config,
        isActive: true,
        type: 'chat',
        labels,
      });
      console.log(`✅ Created/updated branching prompt ${fullName}`);
    } catch (e: any) {
      console.error(`⚠️ Could not create/update ${fullName}:`, e?.message || e);
    }
  }

  await upsert('wash-branch-plan', BRANCH_PLAN_CN, 'cn', ['wash-novel-plus', 'branch-plan', 'cn']);
  await upsert('wash-branch-plan', BRANCH_PLAN_EN, 'en', ['wash-novel-plus', 'branch-plan', 'en']);

  await upsert('wash-branch-write', BRANCH_WRITE_CN, 'cn', ['wash-novel-plus', 'branch-write', 'cn']);
  await upsert('wash-branch-write', BRANCH_WRITE_EN, 'en', ['wash-novel-plus', 'branch-write', 'en']);

  console.log('✨ Branching prompts upload finished');
}

uploadBranchingPrompts().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error while uploading branching prompts:', err);
  process.exit(1);
});
