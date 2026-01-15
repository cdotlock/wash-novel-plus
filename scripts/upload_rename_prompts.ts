import { Langfuse } from 'langfuse';
import 'dotenv/config';

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY || '',
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

// Node-level rename prompt: apply characterMap to an already generated node
// CN prompt
const RENAME_PROMPT_CN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `你是一名文字编辑，负责在保持文意基本不变的前提下，统一替换角色名字。

你会得到：
- originalContent：一整段已经生成好的节点文本（Markdown）；
- characterMapJson：一个 JSON，对象形如 { "原名A": "新名A", "原名B": "新名B", ... }。

你的任务：
1. 通读 originalContent，找出所有属于这些角色名字/称呼/外号的出现；
2. 严格按照 characterMapJson 中的映射，将所有相关称呼替换为“新名字风格一致”的写法；
3. 除了名字和直接相关的称呼外，不要随意改动句子内容和事件细节；
4. 保留 Markdown 结构（段落、列表、强调等）。

输出要求：
- 直接输出整段【替换后的】节点文本（Markdown）；
- 不要输出 JSON，不要加解释文字，不要包裹在 \`\`\` 代码块中。`,
    },
    {
      role: 'user',
      content: `【原始节点内容】\n{{originalContent}}\n\n【角色映射表 JSON】\n{{characterMapJson}}\n\n请根据映射表，返回替换后的一整段节点文本（Markdown）。不要输出任何解释或额外内容。`,
    },
  ],
  config: { temperature: 0.3 },
};

// EN prompt
const RENAME_PROMPT_EN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `You are a careful line editor. Your job is to NORMALIZE CHARACTER NAMES in an already written node, without changing the story.

You will receive:
- originalContent: the full generated node text in Markdown;
- characterMapJson: a JSON object like { "Old Name A": "New Name A", "Old Name B": "New Name B", ... }.

Your task:
1. Read originalContent and locate all mentions of these characters, including full names, common short forms, and obvious nicknames;
2. Apply the mapping from characterMapJson strictly, rewriting those mentions into the new names (or clearly consistent variants);
3. Do NOT change plot details or meaning beyond what is necessary for the rename;
4. Preserve the Markdown structure (paragraphs, lists, emphasis, etc.).

Output requirements:
- Output ONLY the full rewritten node text (Markdown);
- Do NOT output JSON, explanations, or wrap the text in code fences.`,
    },
    {
      role: 'user',
      content: `【Original node content】\n{{originalContent}}\n\n【Character map JSON】\n{{characterMapJson}}\n\nApply the mapping and return the FULL rewritten node text (Markdown only), with no extra commentary.`,
    },
  ],
  config: { temperature: 0.3 },
};

async function uploadRenamePrompts() {
  console.log('🚀 Uploading wash-rename-node-{lang} prompts to Langfuse...');

  async function upsert(name: string, data: { prompt: any[]; config?: any }, lang: 'cn' | 'en') {
    const fullName = `${name}-${lang}`;
    try {
      await langfuse.createPrompt({
        name: fullName,
        prompt: data.prompt,
        config: data.config,
        isActive: true,
        type: 'chat',
        labels: ['wash-novel-plus', 'rename-node', lang],
      });
      console.log(`✅ Created/updated rename prompt ${fullName}`);
    } catch (e: any) {
      console.error(`⚠️ Could not create/update ${fullName}:`, e?.message || e);
    }
  }

  await upsert('wash-rename-node', RENAME_PROMPT_CN, 'cn');
  await upsert('wash-rename-node', RENAME_PROMPT_EN, 'en');

  console.log('✨ Rename prompts upload finished');
}

uploadRenamePrompts().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error while uploading rename prompts:', err);
  process.exit(1);
});
