import { Langfuse } from 'langfuse';
import 'dotenv/config';

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY || '',
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

const REVIEW_PROMPT_CN = {
  prompt: [
    {
      role: 'system',
      content: `你是一名严格的游戏剧情主编，需要对生成的节点内容进行结构化审稿和打分。

请只输出一个 JSON 对象（不要使用 Markdown 代码块、不要输出解释文字），结构必须如下：
{
  "score": 4,
  "completeness": 4,
  "emotionalImpact": 3,
  "logicalConsistency": 5,
  "choiceQuality": 4,
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"]
}

字段含义与评分标准（1-5 分）：
- score：综合评分（不是平均值，而是你对整体质量的主观总评）。
- completeness：完整性。剧情是否覆盖了本节点规划中应该出现的关键冲突 / 信息点？
- emotionalImpact：情感张力。人物情绪是否到位，是否能打动玩家？
- logicalConsistency：逻辑自洽。与前文和设定是否一致，是否存在硬伤？
- choiceQuality：抉择质量。结尾给出的玩家选项是否有真实后果和冲突，而不是表面不同实则相同？
- issues：用简短句子列出本节点存在的主要问题，可以为 0~N 条。
- suggestions：针对 issues 给出对应的修改建议，可以为 0~N 条。

评分参考：
- 5 分：非常优秀，问题极少或可以忽略，完全可直接使用。
- 4 分：整体很好，有少量可以优化的小问题。
- 3 分：勉强及格，结构或文风较普通，存在一些需要修改的问题。
- 2 分：较差，存在明显逻辑/风格问题，不宜直接使用。
- 1 分：极差，几乎不可用。

请严格遵守以下约束：
1. 只能输出一个 JSON 对象，不能输出数组，也不能在 JSON 前后加说明文字。
2. 所有评分字段必须是数字（1-5），不要用字符串。
3. issues / suggestions 必须是字符串数组（即使只有一条，也要放在数组里）。`,
    },
    {
      role: 'user',
      content: `【节点类型】：{{nodeType}}
【节点内容】：
{{nodeContent}}

请根据上述标准返回 JSON：`,
    },
  ],
  config: { temperature: 0.3 },
};

const REVIEW_PROMPT_EN = {
  prompt: [
    {
      role: 'system',
      content: `You are a strict narrative editor for a game. Your task is to REVIEW one generated node and return a structured JSON score.

You MUST output a single JSON object (no Markdown fences, no extra commentary) with the following shape:
{
  "score": 4,
  "completeness": 4,
  "emotionalImpact": 3,
  "logicalConsistency": 5,
  "choiceQuality": 4,
  "issues": ["Issue 1", "Issue 2"],
  "suggestions": ["Suggestion 1", "Suggestion 2"]
}

Field semantics and 1-5 scoring:
- score: Overall score (NOT a simple average; your holistic judgment of quality).
- completeness: Does the node cover the key conflict / information expected for this planned event?
- emotionalImpact: Is the emotional arc strong and appropriate for the characters and situation?
- logicalConsistency: Is the content self-consistent and consistent with prior context / world rules?
- choiceQuality: Are the player choices at the end meaningful, with real tension or consequences (not fake choices)?
- issues: Short bullet-style sentences describing main problems in this node (0..N items).
- suggestions: Concrete suggestions on how to fix or improve the issues (0..N items).

Scoring guideline:
- 5: Excellent. Very strong writing, coherent logic, strong interactivity, almost no issues.
- 4: Good. Overall solid with a few minor flaws.
- 3: Pass. Serviceable but plain; some issues that should be fixed.
- 2: Poor. Clear logical or stylistic problems; not suitable for direct use.
- 1: Very poor. Essentially unusable.

Hard constraints:
1. Output exactly ONE JSON object, not an array, and no text before/after it.
2. All scoring fields must be numbers (1-5), not strings.
3. issues and suggestions MUST be arrays of strings (even if there is only one item).`,
    },
    {
      role: 'user',
      content: `Node Type: {{nodeType}}
Node Content:
{{nodeContent}}

Please return the review JSON as specified above:`,
    },
  ],
  config: { temperature: 0.3 },
};

async function uploadReviewPrompts() {
  console.log('🚀 Uploading review prompts wash-review-{lang} to Langfuse...');

  async function upsert(name: string, data: { prompt: any[]; config?: any }, lang: 'cn' | 'en') {
    const fullName = `${name}-${lang}`;
    try {
      await langfuse.createPrompt({
        name: fullName,
        prompt: data.prompt,
        config: data.config,
        isActive: true,
        type: 'chat',
        labels: ['wash-novel-plus', 'review', lang],
      });
      console.log(`✅ Created review prompt ${fullName}`);
    } catch (e: any) {
      console.error(`⚠️ Could not create ${fullName}:`, e?.message || e);
    }
  }

  await upsert('wash-review', REVIEW_PROMPT_CN, 'cn');
  await upsert('wash-review', REVIEW_PROMPT_EN, 'en');

  console.log('✨ Review prompts upload finished');
}

uploadReviewPrompts().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error while uploading review prompts:', err);
  process.exit(1);
});
