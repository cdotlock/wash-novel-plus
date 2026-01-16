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

// --- Per-branch event planning prompt ---

const BRANCH_EVENTS_CN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `你是一名严谨的剧情策划，专门为「单条支线」设计一个小而完整的事件序列（3~8 个事件）。

你将会得到：
- fromNodeId：支线从哪个主线节点开始分叉；
- returnNodeId：若为 convergent 支线，则为回归到哪个主线节点（大于 fromNodeId）；若为 divergent，则可能为 null；
- branchType："divergent" 或 "convergent"；
- branchSummary：该支线的大致设定与走向（来自上一阶段的支线概要）；
- mainContext：与本支线强相关的主线节点摘要列表（包含节点编号、描述和内容片段），已按顺序拼接好。

你的任务：
1. 基于 branchSummary 和 mainContext，为这一条支线设计一小串关键事件（通常 3~8 个）。
2. 每个事件都要：
   - 有一个清晰的标题或一句话总结（title / summary）；
   - 指明主要参考的主线节点编号（anchorMainNodeId），用于后续写作时获取主线片段；
   - 让事件之间具备明确的推进关系，整体组成一条合理的支线剧情路线。
3. 总体要求：
   - divergent 支线：从 fromNodeId 所在情节自然分叉，事件序列应该走向一个「不再回到主线」的结局。
   - convergent 支线：从 fromNodeId 分叉，事件序列中后段要逐步朝向 returnNodeId 所在主线节点的状态，使回归显得自然合理。
   - 事件数量控制在 minEvents~maxEvents 之间（尽量接近中间值，例如 4~6 个）。

输出格式（非常重要）：
- 必须只输出 JSON，不要输出任何解释性文字或 Markdown 代码块；
- 直接输出一个数组，每个元素是一个对象：
  [
    {
      "eventId": 1,
      "anchorMainNodeId": 12,
      "title": "......",
      "summary": "......",
      "notes": "可选的补充说明"
    },
    ...
  ]
- eventId 从 1 开始按顺序递增；
- anchorMainNodeId 必须是 mainContext 中出现过的主线节点编号之一。`,
    },
    {
      role: 'user',
      content: `【支线类型】{{branchType}}\n【支线来自主线节点】fromNodeId = {{fromNodeId}}\n【（可选）支线回归主线节点】returnNodeId = {{returnNodeId}}\n\n【支线概要】\n{{branchSummary}}\n\n【与本支线相关的主线上下文】\n{{mainContext}}\n\n【事件数量控制】\n- minEvents = {{minEvents}}\n- maxEvents = {{maxEvents}}\n\n请只输出一个 JSON 数组，每个元素包含 "eventId", "anchorMainNodeId", "title", "summary", "notes?"。\n不要输出任何额外文字。`,
    },
  ],
  config: { temperature: 0.5 },
};

const BRANCH_EVENTS_EN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `You are a meticulous narrative designer. For a SINGLE branch route, you will design a small but complete sequence of EVENTS (typically 3–8).

You will be given:
- fromNodeId: the main-line node where this branch diverges;
- returnNodeId: for convergent branches, the main-line node where the branch should naturally rejoin (greater than fromNodeId); may be null for divergent branches;
- branchType: "divergent" or "convergent";
- branchSummary: a short description of what this branch is about (its variations and overall direction);
- mainContext: a pre-composed list of relevant main-line nodes (each with index, description, and snippet), already ordered for you.

Your job:
1. Based on branchSummary and mainContext, design a short sequence of key events for this single branch (usually 3–8 events).
2. For each event you must:
   - Provide a clear, short title or one-sentence summary;
   - Indicate which main-line node it is most anchored to via anchorMainNodeId (for later text generation);
   - Ensure that events, in order, form a coherent mini-arc for this branch.
3. Global constraints:
   - divergent branches: start from fromNodeId and eventually lead to an alternate ending that does NOT return to the main line.
   - convergent branches: start from fromNodeId, explore a meaningful detour, and gradually steer back towards the situation implied by returnNodeId so that rejoining feels natural.
   - Keep the number of events between minEvents and maxEvents (ideally around the middle, e.g. 4–6).

OUTPUT FORMAT (critical):
- Output JSON ONLY. No explanations, no Markdown fences, no commentary.
- Output a plain array of objects, e.g.:
  [
    {
      "eventId": 1,
      "anchorMainNodeId": 12,
      "title": "...",
      "summary": "...",
      "notes": "optional extra notes"
    },
    ...
  ]
- eventId MUST start from 1 and increase by 1.
- anchorMainNodeId MUST be one of the main-line node indices that appear in mainContext.`,
    },
    {
      role: 'user',
      content: `【Branch type】{{branchType}}\n【Branch diverges from main node】fromNodeId = {{fromNodeId}}\n【(Optional) Branch returns to main node】returnNodeId = {{returnNodeId}}\n\n【Branch summary】\n{{branchSummary}}\n\n【Relevant main-line context】\n{{mainContext}}\n\n【Event count control】\n- minEvents = {{minEvents}}\n- maxEvents = {{maxEvents}}\n\nPlease output ONLY a JSON array, where each element has "eventId", "anchorMainNodeId", "title", "summary", and optional "notes". Do NOT output anything else.`,
    },
  ],
  config: { temperature: 0.5 },
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
- mainSnippet：主线对应片段的正文摘要或原文片段（包含分叉前的上下文，可能还包含回归节点的片段说明）；
- branchType："divergent" 或 "convergent"；
- returnSnippet（仅当 branchType 为 convergent 提供）：回归主线节点开头的一小段原文片段。

【写作总体要求】
- 叙事风格与主线保持一致（人称、语气、节奏、世界观设定）。
- 不要写成「提纲」或「流水账」，而是真正可直接游玩的剧情文本，具备细节描写和情绪起伏。
- 篇幅大致与普通主线节点相当，可以理解为：有完整的起承转合，主干剧情不少于 800～2000 字（根据语言自动调节），避免只有几句台词或三两段就草草结束。

【内部思考方式（不要写出来）】
- 先在心里根据 baseDescription 和 mainSnippet 推演出：本支线的起点、关键冲突、2~4 个重要转折点，以及结尾的情绪落点；
- 想清楚「与主线相比，这条支线在人物选择 / 事件走向 / 情绪体验上有什么差异」；
- 在正式写作时，只输出最终的故事文本，不要把上述思考过程、分析、列表直接写出来。

【分支类型要求】
- 如果 branchType = "divergent"：
  - 让剧情从 mainSnippet 所描述的情境自然分叉出去，走向一个“完整但不同”的结局；
  - 不要再回到主线，结尾写成一个相对收束的结局（可以是 BE / 真结局 / 隐藏结局等），并在情节或情绪上强调与主线命运的差异；
  - 可以适度呼应主线的重要道具 / 伏笔，但不要复制主线文本。
- 如果 branchType = "convergent"：
  - 让剧情从 mainSnippet 分叉，经历一段在情节或情绪上有明显增量的支线（新增人物互动、事件分支、情绪弧线等）；
  - 在分支末尾，自然地把人物 / 状态 / 场景「送回」 returnSnippet 所描述的开场状态或其近似状态；
  - 你可以在结尾用一两句过渡语句对齐 returnSnippet 的情绪或场景，但不要直接复制原文。

【输出形式与结构要求】
- 只输出 Markdown 文本（段落、对话、列表皆可），不要出现 JSON 或解释性文字；
- 不要使用 \`\`\` 代码块包裹全文；
- 结尾必须包含一个「### 选择」小节，下面用 Markdown 列表列出 2~3 个可选行动；
- 每个选项用自然语言描述清楚，不要只写“选项一/选项二”，要包含动作与潜在后果提示。

下面给出一个【完整示例】，展示大致格式与风格（不要抄示例里的具体内容）：`,
    },
    {
      role: 'user',
      content: `【主线节点 ID】12\n【支线类型】divergent\n【支线设定概要】主角在夜晚独自调查旧宅，发现与童年记忆相关的秘密。\n\n【主线原文片段 / 摘要】\n主线中，白天的调查被各种人打断，真正的关键线索一直没有浮出水面。夜晚，旧宅无人，只有风声和吱呀作响的楼梯。\n\n【回归主线片段（仅当为 convergent 时有效）】\n(无)`,
    },
    {
      role: 'assistant',
      content: `夜色彻底落下时，你终于摆脱了同伴和旁人的视线，一个人摸回了山腰上的旧宅。
潮湿的木门在你推开的瞬间发出刺耳的响声，像是在抗议，也像是在提醒——这里不欢迎任何人。

你举起手电，光束划过蒙尘的相框和剥落的墙纸。许多年前，你在这里摔倒、哭泣、躲在桌子底下偷听大人说话的画面，一点点从记忆深处浮起。空气里混杂着霉味和残存的香水味，时间仿佛没有真正流走，只是被按下了暂停键。

顺着木楼梯往上，每踩一步都会发出吱呀声。你本能地屏住呼吸，生怕惊醒什么沉睡的东西。二楼走廊尽头，那扇你从小就被禁止靠近的房门半掩着，门缝里透出一线微弱的黄光——和你记忆中某个暴风雨之夜一模一样。

你推门而入。
屋内的摆设几乎没有变化：破旧的书桌、被白布罩住的梳妆台，还有墙上那幅被划伤了一道的全家福。不同的是，书桌上多了一本摊开的日记本，纸张边缘已经卷起，墨迹却意外清晰。

你翻开日记。
字里行间写满了某个亲人对“真相”的犹豫与恐惧：关于那场意外、关于你为何被刻意远离旧宅、关于一笔从未解释过的“赔偿金”。读得越多，你越能感觉到，自己以为理所当然的一切，只是大人们搭建出来的安全幻觉。

当你看到最后一页时，日记的笔迹突然戛然而止。纸页下方压着一串生了锈的钥匙，上面挂着一块早已褪色的小木牌，上面刻着你的名字。

你抬起头，旧宅深处的黑暗似乎正安静地注视着你，等待你的下一步选择。

### 选择
- 立刻拿起钥匙，顺着记忆中最害怕的那扇地下室门走去，亲自打开被封存多年的真相。
- 把日记和钥匙一起带走，先回到同伴身边，再决定是否分享这些内容。
- 将日记放回原处，只带走钥匙，假装什么都没有发现，把这份秘密只留给自己。`,
    },
    {
      role: 'user',
      content: `【主线节点 ID】{{fromNodeId}}\n【支线类型】{{branchType}}\n【支线设定概要】{{baseDescription}}\n\n【主线原文片段 / 摘要】\n{{mainSnippet}}\n\n【回归主线片段（仅当为 convergent 时有效）】\n{{returnSnippet}}\n\n请写出对应的支线剧情节点文本（Markdown）。不要输出任何解释文字，只输出最终故事和结尾的「### 选择」段落。`,
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
- mainSnippet: a snippet or summary of the corresponding main-line text segment (including context before divergence, and possibly a hint for the return node);
- branchType: "divergent" or "convergent";
- returnSnippet (only when branchType = "convergent"): the first paragraph or a short snippet of the main-line node where the branch should rejoin.

[Overall writing requirements]
- Match the tone, narrative voice, POV, and style of the main story.
- Do NOT write an outline or bullet-point summary; produce real, polished narrative prose with concrete details and emotional beats.
- Length: roughly comparable to a normal main-line node. Aim for a complete scene arc with clear beginning, build-up, and resolution (often ~800–2000 words depending on language and pacing). Avoid ultra-short stubs.

[Internal reasoning guidelines (do NOT output this thinking)]
- First, silently plan a mini-outline in your head: how the branch starts from mainSnippet, 2–4 key turning points, and how it should end emotionally;
- Decide how this branch meaningfully diverges from the main route in terms of character choices, plot outcomes, or emotional experience;
- When you write, output ONLY the final story text. Do NOT print your outline, analysis, or step-by-step reasoning.

[Branch-type specific rules]
- If branchType = "divergent":
  - Let the story diverge naturally from the situation described in mainSnippet and lead to a DISTINCT alternative ending (good/bad/secret, etc.).
  - Do NOT return to the main line; end with a reasonably conclusive ending that highlights how this fate differs from the canonical route.
  - You may echo important motifs/foreshadowing from the main line, but do not copy the original text.
- If branchType = "convergent":
  - Let the story diverge from mainSnippet, explore a meaningful detour with added character beats or events, then NATURALLY steer the characters/world back into the state suggested by returnSnippet.
  - You may briefly bridge into the return state at the end, matching its emotional tone or setting, but do not copy-paste the original wording.

[Output format & structure requirements]
- Output plain Markdown text only (paragraphs, dialogue, lists, etc.).
- Do NOT wrap the text in \`\`\` fences.
- Do NOT output JSON or any explanations.
- At the end, you MUST include a "### Choices" section with 2–3 bullet-point options, each describing a concrete player action and hinting at its consequence.

Below is a FULL EXAMPLE to illustrate the desired style and structure (do NOT copy its content):`,
    },
    {
      role: 'user',
      content: `【Main-line node ID】7\n【Branch type】convergent\n【Branch concept】The protagonist returns alone to the abandoned training ground at night, confronting an unresolved fear.\n\n【Main-line snippet / summary】\nIn the main route, this location is briefly mentioned as a childhood memory, but the group quickly moves on without exploring it in detail.\n\n【Return snippet (only meaningful for convergent)】\nThe main line later resumes with the party leaving the city at dawn, as if nothing special happened during the night.`,
    },
    {
      role: 'assistant',
      content: `By the time you slip away from the inn, the streets have emptied.
Only the wind remembers the way to the old training ground.

You pass through alleys you used to run through as a child, feet landing in familiar rhythms on worn stone. Every corner turns up a ghost of the past—an overturned crate, a faded chalk mark, a rusted gate half-hanging from its hinge. The closer you get, the quieter the city becomes, until even your own breathing sounds too loud.

The training ground waits for you where it always has, behind the cracked wall and the sagging wooden door. You push it open with the same hesitant strength you had back then. The hinges groan a protest, and a stale, dusty smell spills out, tasting of old sweat and fear.

Moonlight spills across the yard, silvering the dummies and the stone tiles. The ring of training swords, the barked orders of the instructor, the sting of failure—you can feel them all layered under the silence. In the center of the yard, the stain you once slipped in during a spar is still faintly visible, as if the stone never quite forgot.

You move to the rack where the wooden swords once hung. Only one remains, splintered along the grain. Your hand closes around it anyway. The weight is wrong, lighter than you remember, but the rough texture grounds you. You swing once, twice, listening to the dull swish through the cold air.

A memory surfaces: not of glory, but of the moment you walked away—too humiliated, too afraid to return, letting others decide who you were. Tonight, there is no instructor to judge you, no classmates to laugh. Only the moon, the dust, and the echo of your own heartbeat.

You plant your feet in the center of the yard.
This time, you choose your own opponent.

### Choices
- Keep training alone until dawn, pushing your body past exhaustion, and leave this place with a quiet, private victory no one else will ever know about.
- Carve a small mark into the stone with the broken sword and swear to return here with your companions one day, turning this forgotten yard into part of your shared story.
- Lay the wooden sword carefully on the rack, bow once to the empty ground, and walk away without looking back, accepting that some ghosts are meant to stay behind.`,
    },
    {
      role: 'user',
      content: `【Main-line node ID】{{fromNodeId}}\n【Branch type】{{branchType}}\n【Branch concept】{{baseDescription}}\n\n【Main-line snippet / summary】\n{{mainSnippet}}\n\n【Return snippet (only meaningful for convergent)】\n{{returnSnippet}}\n\nWrite the side-branch node in Markdown. Follow the style of the example above: immersive narrative plus a final "### Choices" section. Do not output any explanations.`,
    },
  ],
  config: { temperature: 0.7 },
};

async function uploadBranchingPrompts() {
  console.log('🚀 Uploading wash-branch-{plan,events,write}-{lang} prompts to Langfuse...');

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

  await upsert('wash-branch-events', BRANCH_EVENTS_CN, 'cn', ['wash-novel-plus', 'branch-events', 'cn']);
  await upsert('wash-branch-events', BRANCH_EVENTS_EN, 'en', ['wash-novel-plus', 'branch-events', 'en']);

  await upsert('wash-branch-write', BRANCH_WRITE_CN, 'cn', ['wash-novel-plus', 'branch-write', 'cn']);
  await upsert('wash-branch-write', BRANCH_WRITE_EN, 'en', ['wash-novel-plus', 'branch-write', 'en']);

  console.log('✨ Branching prompts upload finished');
}

uploadBranchingPrompts().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error while uploading branching prompts:', err);
  process.exit(1);
});
