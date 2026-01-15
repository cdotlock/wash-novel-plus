import { Langfuse } from 'langfuse';
import 'dotenv/config';

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY || '',
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

const CHARACTER_PROMPT_CN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `你是一个角色设定总监。下面是整本小说中自动提取出来的角色出现记录汇总（去重后按名字聚合）。

每个条目包含：
- name：角色原名；
- count：在章节中被提及的次数；
- roles：模型在不同章节中给出的角色定位/身份标签；
- aliases：模型识别到的外号、代号或别称。

你的任务：
1. 合并同一角色的不同写法与别名，例如："叶凡"、"叶天帝"、"圣体少年" 如果明显是同一个人，应当统一。
2. 为每个“角色实体”生成一个新的、风格统一且易于区分的名字（可以偏游戏化、便于玩家记忆）。
3. 输出一个 JSON 对象，key 为“原始名字或别名”，value 为“最终采用的新名字”。
   - 请尽量涵盖常见写法，例如：如果你认定 "叶凡" 和 "叶天帝" 是一人，则应当同时给出：{"叶凡": "韩立", "叶天帝": "韩立"}。
4. 不要输出任何解释性文字、Markdown 代码块或注释，只能输出纯 JSON。`,
    },
    {
      role: 'user',
      content: `以下是角色出现统计（JSON 数组）：\n{{charactersJson}}\n\n请只输出 {"原名或别名": "新名字"} 形式的 JSON 映射表。`,
    },
  ],
  config: { temperature: 0.4 },
};

const CHARACTER_PROMPT_EN = {
  type: 'chat',
  prompt: [
    {
      role: 'system',
      content: `You are a character naming director.

You are given an aggregated list of character appearances extracted from a long novel.
Each item includes:
- name: original name as it appears in text;
- count: how many times it appears;
- roles: rough role/identity labels from previous passes;
- aliases: nicknames, titles, or alternative spellings.

Your job:
1. Merge entries that clearly refer to the same underlying character (e.g. "Ye Fan", "The Holy Physique", "Emperor Ye").
2. For each character entity, design a new, consistent in-universe name suitable for a game (memorable, distinct, stylistically coherent).
3. Output a JSON object mapping every original name or alias to the final canonical name.
   - For example: {"Ye Fan": "Han Li", "Emperor Ye": "Han Li"}.
4. Do NOT output explanations, Markdown fences, or comments. Return raw JSON only.`,
    },
    {
      role: 'user',
      content: `Here is the aggregated character list as JSON array:\n{{charactersJson}}\n\nReturn ONLY the JSON map {"original_or_alias": "canonical_name"}.`,
    },
  ],
  config: { temperature: 0.4 },
};

async function uploadCharacterPrompts() {
  console.log('🚀 Uploading wash-characters-{lang} prompts to Langfuse...');

  async function upsert(name: string, data: { prompt: any[]; config?: any }, lang: 'cn' | 'en') {
    const fullName = `${name}-${lang}`;
    try {
      await langfuse.createPrompt({
        name: fullName,
        prompt: data.prompt,
        config: data.config,
        isActive: true,
        type: 'chat',
        labels: ['wash-novel-plus', 'characters', lang],
      });
      console.log(`✅ Created character prompt ${fullName}`);
    } catch (e: any) {
      console.error(`⚠️ Could not create ${fullName}:`, e?.message || e);
    }
  }

  await upsert('wash-characters', CHARACTER_PROMPT_CN, 'cn');
  await upsert('wash-characters', CHARACTER_PROMPT_EN, 'en');

  console.log('✨ Character prompts upload finished');
}

uploadCharacterPrompts().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error while uploading character prompts:', err);
  process.exit(1);
});
