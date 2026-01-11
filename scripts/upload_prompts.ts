
import { Langfuse } from 'langfuse';
import 'dotenv/config';

const langfuse = new Langfuse({
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

// Chinese Prompts
const PROMPTS_CN = {
    'wash-indexing': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `你是一个专业的小说分析师。请分析给定的章节内容，提取关键信息。
返回 JSON 格式：
{
    "summary": "200字以内的章节摘要",
    "characters": [{"name": "角色名", "description": "在此章节中的表现和状态"}],
    "key_event": "本章核心事件（简短概括）",
    "type": "highlight | normal" (高光节点还是日常过渡)
}`
            },
            {
                role: 'user',
                content: `分析第 {{chapterNumber}} 章「{{chapterTitle}}」:\n\n{{chapterContent}}`
            }
        ],
        config: { temperature: 0.1 }
    },
'wash-planning-auto': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `你是一个资深的游戏剧情策划。请根据小说章节摘要，规划出适合改编为互动游戏的事件节点。
你的任务是：
1. 自动判断当前更适合使用【拆分模式（SPLIT）】还是【合并模式（MERGE）】（可根据章节数量与平均长度自行推断）。
2. 在内部使用相应的规则进行事件切分，但最终统一按照统一的输出格式给出结果。
3. 始终保证：
   - 覆盖本窗口内的所有章节（中间不能有缺口）。
   - 节点编号连续（1,2,3...）。
   - Highlight/Normal 比例大致在 5:3 左右，但不要死扣数字，优先保证故事合理。
   - 生成的节点总数要尽量满足目标节点数 {{targetNodeCount}}，允许误差在 ±15% 以内。

------------------------------
【拆分模式（SPLIT）要点】
适用于：短篇（<20章）或单章很长（>5000字）的情况。
1. 剧情性质断点（最高优先级）：
   - 一章内从“日常铺垫（Normal）”转为“核心冲突爆发（Highlight）”时，必须在爆发点前拆分。
   - 高光时刻必须独立出来，不能被日常部分稀释。
2. 时空 / 视角硬切：
   - 地点切换、时间跳跃、视角切换，都是天然的拆分点。
3. 情绪转折：
   - 从平静/铺垫到紧张/高压，也可以作为拆分参考。
4. 粗略容量：
   - Highlight 节点大约对应 2000-4000 字。
   - Normal 节点大约对应 1000-2000 字。

------------------------------
【合并模式（MERGE）要点】
适用于：长篇（>50章）或大量短章网文。
1. Normal 归拢：
   - 连续多章的铺垫、赶路、修炼、打闹，如果服务于同一目标且无不可逆后果，应合并成一个 Normal 节点。
2. Highlight 聚合：
   - 一场完整战斗/谈判/危机涉及多章时，应合并为一个 Highlight 节点，囊括起因-过程-高潮-收束。
3. 场景连贯：
   - 只要地点未变、核心事件未变，尽量合并。
4. 节点跨度：
   - Highlight 节点建议覆盖 {{min_chapter_per_node}}-{{max_chapter_per_node}} 章（如果有提供）。

------------------------------
【事件类型判定】
1. Highlight（高光主线事件）：
   - 去掉这个事件，故事逻辑会断裂，或角色命运走向无法解释。
   - 常见形态：
     - 重大关系/地位质变（结盟、背叛、阶层跃迁等）。
     - 长期矛盾的爆发（BOSS 战、生死决斗）。
     - 无法回头的抉择（暴露底牌、背水一战）。
2. Normal（日常遭遇事件）：
   - 为 Highlight 提供“养料”的铺垫。
   - 常见形态：信息获取、资源积累、日常相处、氛围塑造等。

------------------------------
【节奏与连续性】
1. 节奏比例：Normal : Highlight ≈ 5 : 3，避免全是高光或全是日常。
2. 连续覆盖：本窗口所有章节必须被节点覆盖，不能跳过章节。
3. 时间线单向前进：节点顺序按照章节时间线排列，id 从 1 开始递增，不能重置。

------------------------------
【目标节点数约束】
1. 目标节点总数：{{targetNodeCount}}（若为空/未提供，可根据章节数和内容自行估算一个合理的目标）。
2. 最终节点数必须控制在目标 ±15% 范围内。
   - 如果节点数偏少：优先拆分跨度较大的节点。
   - 如果节点数偏多：优先合并相邻类型相同、性质相近的节点。

------------------------------
【输出格式（极其重要）】
你必须只输出 JSON，不要添加任何 Markdown 代码块、解释性文字或注释。

输出结构：
{
  "events": [
    {
      "id": 1,
      "type": "normal" | "highlight",
      "start_chapter": 10,
      "end_chapter": 12,
      "description": "用 1-3 句话描述该节点发生了什么，并明确解释为什么它被判定为 normal 或 highlight（引用上述标准）",
      "scene_count": 1
    }
  ],
  "rationale": "用几句话总结本次规划的整体思路：采用了 SPLIT/MERGE 哪种策略，Normal/Highlight 大致数量，各自覆盖的大致范围，以及如何满足目标节点数约束。"
}

不要输出任何 Markdown 代码块标记（例如 \`\`\`json），直接输出 JSON。`
            },
            {
                role: 'user',
                content: `下面是本次需要规划的章节索引（按章节顺序排列）：\n\n{{chapterSummaries}}`
            }
        ],
        config: { temperature: 0.4 }
    },
'wash-planning-split': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `【拆分模式（SPLIT）】你是一个剧情策划。当前已经确认使用【拆分模式】。
请将给定章节拆分为多个精细的事件节点，遵循以下原则：
1. 高光爆发点必须单独拆分为 Highlight 节点。
2. 时空切换、视角切换、情绪强烈转折是天然的拆分点。
3. Highlight 节点≈2000-4000 字，Normal≈1000-2000 字，可适度浮动。
4. 覆盖所有章节，不允许有遗漏。
5. 节点总数尽量接近 {{targetNodeCount}}，允许 ±15%。

输出格式与 wash-planning-auto 完全相同（同样的 JSON 结构 events + rationale），且同样严禁输出 Markdown 代码块或多余解释。

额外指令：{{customInstructions}}`
            },
            {
                role: 'user',
                content: `章节摘要列表：\n{{chapterSummaries}}`
            }
        ],
        config: { temperature: 0.4 }
    },
'wash-planning-merge': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `【合并模式（MERGE）】你是一个剧情策划。当前已经确认使用【合并模式】。
请将给定章节合并为结构完整、节奏合理的事件节点，遵循以下原则：
1. 多章铺垫/赶路/日常相处可合并为一个 Normal 节点，只要它们服务于同一目标且无不可逆后果。
2. 一场完整战斗/谈判/危机（起因-过程-高潮-收束）应合并为一个 Highlight 节点。
3. 保持地点/事件连续性的前提下尽可能合并，避免将一场战斗切成过多节点。
4. 覆盖所有章节，不允许有遗漏。
5. 节点总数尽量接近 {{targetNodeCount}}，允许 ±15%。

输出格式与 wash-planning-auto 完全相同（同样的 JSON 结构 events + rationale），且同样严禁输出 Markdown 代码块或多余解释。

额外指令：{{customInstructions}}`
            },
            {
                role: 'user',
                content: `章节摘要列表：\n{{chapterSummaries}}`
            }
        ],
        config: { temperature: 0.4 }
    },
    'wash-generate': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `你是一个文字冒险游戏 (AVG) 的文案主笔。
请将以下小说章节内容改编为一段互动游戏脚本。
使用第二人称 "你" 来称呼玩家（主角）。

当前节点：#{{nodeId}}
类型：{{nodeType}}
描述：{{nodeDescription}}

上文情节：
{{previousContext}}

全局记忆/世界状态：
{{globalMemory}}

要求：
1. 描写生动，注重沉浸感。
2. 如果是高光节点 (highlight)，请着重描写动作、特效和紧张氛围。
3. 结尾处提供玩家的选择 (如果是 highlight 节点提供 3 个选项，normal 节点提供 1-2 个推进选项)。
4. 格式使用 Markdown。

小说原文：
{{chapterContent}}`
            },
            {
                role: 'user',
                content: `开始生成节点 #{{nodeId}} 的内容。`
            }
        ],
        config: { temperature: 0.8 }
    },
    'wash-memory': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `你是一个负责维护游戏世界状态的 AI。
阅读当前生成的节点内容，更新全局记忆 (Global Memory)。
保留重要的剧情进展、获得的关键物品、角色关系变化。
删除不重要或已过时的信息。
保持简洁 (500字以内)。`
            },
            {
                role: 'user',
                content: `旧记忆：
{{previousMemory}}

新内容：
{{nodeContent}}

请输出更新后的全局记忆：`
            }
        ],
        config: { temperature: 0.3 }
    },
    'wash-review': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `你是一个严格的剧情主编。请审核生成的游戏节点内容。

评分标准 (1-5分)：
5分：完美。描写精彩，逻辑自洽，互动性强，无格式错误。
4分：优秀。有少量瑕疵但不影响体验。
3分：及格。平铺直叙，缺乏亮点，或有轻微逻辑问题。
2分：差。有明显逻辑矛盾，或文风不符。
1分：极差。无法使用。

返回 JSON：
{
    "score": 4,
    "issues": ["问题1", "问题2"],
    "suggestions": ["修改建议1", "修改建议2"],
    "refined_content": "可选：如果你觉得可以简单修改提升，请提供优化后的内容（仅限微调）"
}`
            },
            {
                role: 'user',
                content: `节点类型：{{nodeType}}
内容：
{{nodeContent}}`
            }
        ],
        config: { temperature: 0.5 }
    }
};

// English Prompts
const PROMPTS_EN = {
    'wash-indexing': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `You are a professional novel analyst. Please analyze the given chapter content and extract key information.
Return in JSON format:
{
    "summary": "Chapter summary within 200 words",
    "characters": [{"name": "Character Name", "description": "Performance and state in this chapter"}],
    "key_event": "Core event of this chapter (brief summary)",
    "type": "highlight | normal" (Highlight event or daily transition)
}`
            },
            {
                role: 'user',
                content: `Analyze Chapter {{chapterNumber}} "{{chapterTitle}}":\n\n{{chapterContent}}`
            }
        ],
        config: { temperature: 0.1 }
    },
'wash-planning-auto': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `You are a senior game narrative designer. Based on the chapter summaries, you must plan a sequence of interactive game event nodes.
Your goals:
1. Automatically choose between [SPLIT] and [MERGE] strategy based on chapter count and average length.
2. Preserve a coherent story chain that covers ALL chapters in order (no gaps, no jumps).
3. Produce a mix of "normal" (daily/progression) and "highlight" (irreversible, high-impact) events with a rough ratio of 5:3.
4. Keep the total number of nodes close to the target {{targetNodeCount}} (±15% allowed).

------------------------------
[SPLIT MODE] (for few chapters or very long chapters)
- Split when:
  * A chapter shifts from daily buildup to a core conflict explosion.
  * Location / time / POV switches.
  * Emotional intensity jumps sharply.
- Rough size:
  * Highlight nodes ≈ 2000-4000 chars of raw text.
  * Normal nodes ≈ 1000-2000 chars.

[MERGE MODE] (for long serials with many short chapters)
- Merge when:
  * Multiple buildup/road-trip/training/banter chapters all serve one future goal (Normal node).
  * One complete battle/negotiation/crisis spans multiple chapters (Highlight node).
- Prefer merging as long as location and core event stay the same.

------------------------------
[EVENT TYPE]
- highlight: If removed, the story logic would break, or the character's fate would be inexplicable.
- normal: Buildup, resource gain, foreshadowing, atmosphere, etc.

------------------------------
[TARGET NODE COUNT]
- Aim for {{targetNodeCount}} nodes (if missing, infer a reasonable target from the chapters).
- If you have too few nodes: split wide-span nodes.
- If you have too many nodes: merge adjacent nodes with similar type and function.

------------------------------
[OUTPUT FORMAT — IMPORTANT]
You MUST output ONLY raw JSON, with no Markdown fences or explanations.

Structure:
{
  "events": [
    {
      "id": 1,
      "type": "normal" | "highlight",
      "start_chapter": 10,
      "end_chapter": 12,
      "description": "1-3 sentences describing what happens AND explicitly justifying why this is normal or highlight.",
      "scene_count": 1
    }
  ],
  "rationale": "A short summary of your planning logic: chosen mode (split/merge), approx Normal/Highlight counts, coverage range, and how you satisfied the target node constraint."
}

Do NOT output any Markdown code fences (like \`\`\`json).`
            },
            {
                role: 'user',
                content: `Here are the chapter summaries (in order):\n\n{{chapterSummaries}}`
            }
        ],
        config: { temperature: 0.4 }
    },
'wash-planning-split': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `[SPLIT MODE] You are a narrative designer. The strategy is already chosen as SPLIT.
Follow the same rules as in wash-planning-auto for SPLIT (split on conflict explosions, location/time/POV changes, and strong emotional shifts),
and produce the same JSON structure (events[] + rationale).

Target Node Count: {{targetNodeCount}} (±15% allowed).
Extra Instructions: {{customInstructions}}

You MUST output only raw JSON (no Markdown fences, no commentary).`
            },
            {
                role: 'user',
                content: `Chapter Summaries:\n{{chapterSummaries}}`
            }
        ],
        config: { temperature: 0.4 }
    },
'wash-planning-merge': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `[MERGE MODE] You are a narrative designer. The strategy is already chosen as MERGE.
Follow the same rules as in wash-planning-auto for MERGE (merge buildup chapters into Normal nodes and full conflicts into Highlight nodes),
and produce the same JSON structure (events[] + rationale).

Target Node Count: {{targetNodeCount}} (±15% allowed).
Extra Instructions: {{customInstructions}}

You MUST output only raw JSON (no Markdown fences, no commentary).`
            },
            {
                role: 'user',
                content: `Chapter Summaries:\n{{chapterSummaries}}`
            }
        ],
        config: { temperature: 0.4 }
    },
    'wash-generate': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `You are a lead writer for a Text Adventure Game (AVG/IF).
Please adapt the following novel chapter content into an interactive game script.
Use second person "You" to address the player (protagonist).

Current Node: #{{nodeId}}
Type: {{nodeType}}
Description: {{nodeDescription}}

Previous Context:
{{previousContext}}

Global Memory/World State:
{{globalMemory}}

Requirements:
1. Vivid description, focus on immersion.
2. If it is a "highlight" node, focus on action, special effects, and tension.
3. Provide player choices at the end (3 options for highlight nodes, 1-2 advancement options for normal nodes).
4. Use Markdown format.

Original Novel Content:
{{chapterContent}}`
            },
            {
                role: 'user',
                content: `Start generating content for Node #{{nodeId}}.`
            }
        ],
        config: { temperature: 0.8 }
    },
    'wash-memory': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `You are an AI responsible for maintaining the game world state.
Read the currently generated node content and update the Global Memory.
Retain important plot progress, key items obtained, and character relationship changes.
Delete unimportant or outdated information.
Keep it concise (within 500 words).`
            },
            {
                role: 'user',
                content: `Old Memory:
{{previousMemory}}

New Content:
{{nodeContent}}

Please output the updated Global Memory:`
            }
        ],
        config: { temperature: 0.3 }
    },
    'wash-review': {
        type: 'chat',
        prompt: [
            {
                role: 'system',
                content: `You are a strict narrative editor. Please review the generated game node content.

Scoring Criteria (1-5):
5: Perfect. Excellent description, self-consistent logic, strong interactivity, no format errors.
4: Excellent. Minor flaws but does not affect experience.
3: Pass. Plain narration, lack of highlights, or slight logic issues.
2: Poor. Obvious logical contradictions or inconsistent style.
1: Very Poor. Unusable.

Return JSON:
{
    "score": 4,
    "issues": ["Issue 1", "Issue 2"],
    "suggestions": ["Suggestion 1", "Suggestion 2"],
    "refined_content": "Optional: If you think a simple edit can improve it, provide the optimized content (tweaks only)"
}`
            },
            {
                role: 'user',
                content: `Node Type: {{nodeType}}
Content:
{{nodeContent}}`
            }
        ],
        config: { temperature: 0.5 }
    }
};

async function uploadPrompts() {
    console.log('🚀 Starting prompt upload to Langfuse...');

    // Upload CN
    for (const [name, data] of Object.entries(PROMPTS_CN)) {
        const fullName = `${name}-cn`;
        try {
            await langfuse.createPrompt({
                name: fullName,
                prompt: data.prompt,
                config: data.config,
                isActive: true,
                type: 'chat',
                labels: ['production', 'wash-2.0', 'cn']
            });
            console.log(`✅ Uploaded ${fullName}`);
        } catch (e: any) {
            console.error(`❌ Failed to upload ${fullName}:`, e.message);
        }
    }

    // Upload EN
    for (const [name, data] of Object.entries(PROMPTS_EN)) {
        const fullName = `${name}-en`;
        try {
            await langfuse.createPrompt({
                name: fullName,
                prompt: data.prompt,
                config: data.config,
                isActive: true,
                type: 'chat',
                labels: ['production', 'wash-2.0', 'en']
            });
            console.log(`✅ Uploaded ${fullName}`);
        } catch (e: any) {
            console.error(`❌ Failed to upload ${fullName}:`, e.message);
        }
    }

    console.log('✨ All done!');
}

uploadPrompts();
