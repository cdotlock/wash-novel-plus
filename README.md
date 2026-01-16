# Wash Novel Plus

Wash Novel Plus（`wash-novel-plus`）是一个将长篇网络小说自动转换为「可玩事件节点」的流水线系统。它负责从原始章节文本出发，依次完成：

1. **索引（Indexing）**：对每一章做结构化摘要、人物提取、关键事件归纳，并标注章节类型（高光 / 日常）。
2. **规划（Planning）**：基于章节索引，用 LLM 规划剧情事件节点（Normal / Highlight），并根据目标节点数进行智能拆分 / 合并。
3. **生成（Generating）**：将每个事件节点对应的章节范围改写为可玩的文字冒险节点（带分支选项），维护全局记忆。
4. **审稿（Reviewing）**：对已生成节点做质量打分与问题分析，必要时自动重写（re-roll）。
5. **导出（Export）**：将所有完成节点导出为 Markdown，方便后续接入游戏引擎或编辑工具。

---

## 架构总览

本仓库主要由三部分组成：

- **API 服务（Fastify + Prisma + BullMQ）**：位于 `src/`，提供 REST API 和基于 Redis 的事件流（SSE）。
- **Workers（BullMQ Worker 集群）**：位于 `src/workers/`，负责索引、规划、生成、审稿等长耗时任务。
- **前端工作台（React/Vite）**：位于 `web-ui/`，提供从上传小说到导出节点的可视化流水线。

核心技术栈：

- Node.js 20+ / TypeScript
- Fastify 5
- PostgreSQL + Prisma
- BullMQ + Redis
- Langfuse（Prompt 管理 & 观察）
- OpenAI SDK（对接 DeepSeek 或其他兼容 OpenAI 的 LLM）

---

## 功能分层

### 1. 索引（Indexing）

- 后端入口：`POST /api/sessions/:id/index`
- Worker：`src/workers/indexer.ts`
- Langfuse Prompt：`wash-indexing-{lang}`（如 `wash-indexing-cn`）

流程：

1. 上传后的章节文本会被标准化为 `Chapter` 结构并保存在 `Session.chapters`（JSON）。
2. Indexer worker 读取所有章节，按批次调用 LLM：
   - 使用 Langfuse 的 `wash-indexing-{lang}` prompt。
   - 输出包含 `summary / characters / key_event / type` 的结构化结果。
3. 将结果写入 `Session.chapterIndex`，并预估：
   - `recommendedMode`（拆分 / 合并 / normal）
   - `targetNodeCount`（推荐节点数）。

所有进度通过 BullMQ + Redis 推送 SSE 事件到前端，包括 `progress / log / complete` 等。

### 2. 规划（Planning）

- 路由：`src/routes/planning.ts`
- Worker：`src/workers/planner.ts`
- Langfuse Prompts：
  - `wash-planning-auto-{lang}`
  - `wash-planning-split-{lang}`
  - `wash-planning-merge-{lang}`
  - `wash-planning-adjust-{lang}`（二次调整节点数）

#### 2.1 单次规划任务

前端在索引完成后或用户点击「重新规划」时调用：

```http
POST /api/sessions/:id/plan
{
  "mode": "auto" | "split" | "merge" | "one_to_one",
  "targetNodeCount": number?,
  "customInstructions": string?,
  "model": string?
}
```

后端逻辑：

1. 校验 Session 已经有 `chapterIndex`。
2. **防止并发规划**：
   - 查询是否存在 `Task` 满足 `sessionId = id AND type = 'planning' AND status IN ('pending','running')`；
   - 若存在则返回 `400 { error: 'Planning already in progress for this session' }`，禁止重复点击。
3. 创建新的 `Task` 记录（type = `planning`），加入 `planning` 队列，并将 `taskId` 返回前端。

#### 2.2 Planner Worker 智能规划策略

文件：`src/workers/planner.ts`

1. 读取 session 的 `chapterIndex` 和 `contentAnalysis`，计算：
   - `resolvedMode`（auto/split/merge/one_to_one）；
   - `resolvedModel`（通常是 reasoning 模型）；
   - `effectiveTargetNodeCount`（优先使用用户输入，否则使用索引阶段推荐值）。
2. `one_to_one` 模式下：
   - 直接按章节一一映射为事件节点，保证稳定可控（每章一个事件）。
3. AI 模式（auto/split/merge）：
   - 使用 `getPlanningPrompt` 调用 Langfuse 的 `wash-planning-{mode}-{lang}` 模板生成初次规划：
     - 内部根据传入的 `chapterSummaries` 与 `targetNodeCount` 说明拆分/合并策略和输出 JSON 结构。
   - 对 LLM 输出执行两阶段解析：
     1. `tryParseJson(response, LLMPlanningResponseSchema)`：严格 JSON 校验，支持 `{ events, rationale }` 或纯数组形式。
     2. 若失败，使用 `parseJsonLoose(response)` 从包含描述文本的答案中提取 JSON 片段，再通过 `normalizePlanningEvents` 统一字段名：
        - `start_chapter | startChapter | start | start_index` → `startChapter`
        - `end_chapter | endChapter | end | end_index` → `endChapter`
        - `type` 中包含 `highlight` / `高光` → `highlight`，否则为 `normal`。
   - 使用 `mergeConsecutiveHighlights` 合并连续的高光事件，并通过 `validateCoverage` 确认所有章节从 `firstChapter` 到 `lastChapter` 都被覆盖，无空洞。
4. **LLM 驱动的节点数调整**：
   - 若配置了 `effectiveTargetNodeCount`，且当前事件数 `events.length` 与目标不符：
     1. 调用 `getPlanningAdjustPrompt` 对应的 Langfuse 模板 `wash-planning-adjust-{lang}`：

        ```ts
        const adjustPrompt = await getPlanningAdjustPrompt({
          mode: resolvedMode,
          chapterSummaries,
          currentEvents: events,
          targetNodeCount: target,
        });
        ```

        模板需根据：
        - `chapterSummaries`：完整章节摘要文本；
        - `currentEvents`：当前事件列表 JSON；
        - `targetNodeCount`：目标节点数；
        再次生成一个满足目标数量约束的新 `events` 数组（只输出 JSON）。

     2. 对调整结果同样进行严格 + 宽松解析，使用 `normalizePlanningEvents` + `mergeConsecutiveHighlights` + `validateCoverage` 规范化。
     3. 如果 LLM 调整后仍然与目标差距较大，使用 `enforceTargetNodeCount` 做一个最后的启发式合并/拆分兜底，确保最终事件数不至于完全偏离目标。

5. 更新分析信息：
   - 在 `Session.contentAnalysis` 中写入：
     - `lastPlanEventCount`: 本轮规划生成的事件数；
     - `lastPlanUserTarget`: 用户本次指定的 `targetNodeCount`（若未指定则为 `null`）。

规划的整个生命周期都会通过 SSE 输出结构化的 thought/log：

- `[Planner] Dispatching planning job via queue "planning" (mode=auto, target=12, model=...)`
- `Analyzing chapter structure and designing event nodes...`
- `[Planner] 调整规划以匹配目标节点数: 当前 18, 目标 12（通过 LLM 二次规划）`
- `Planning complete! Generated 12 event nodes.`

前端在 `step === 'planning'` 时接收到 `complete` 事件，会自动拉取最新的 `/api/sessions/:id/plan` 并刷新事件列表，同时将「正在规划中」提示关闭。

### 3. 生成（Generating）

- 路由：`src/routes/generating.ts`
- Worker：`src/workers/writer.ts`
- Langfuse Prompts：
  - `wash-generate-{lang}`
  - `wash-memory-{lang}`

流程概要：

1. 基于确认的规划结果，将每个事件转换为 `Node`：`{ id, type, startChapter, endChapter, description, status, content }`，存入 `Session.nodes`。
2. Writer worker 对每个节点执行：
   - 聚合对应章节文本为 `chapterContent`；
   - 调用 `wash-generate-{lang}` 生成 Markdown 形式的剧情文本 + 备选项（高光 3 选项，普通 1-2 选项）；
   - 写回节点内容与状态，并通过 SSE 发送：
     - `node_start`（开始生成某个节点）
     - `node_ready`（该节点生成完成，附带内容）
3. 在每个节点生成后，调用 `wash-memory-{lang}` prompt 更新 `Session.globalMemory`，保证后续节点有连续的世界状态。
4. 所有节点完成后，将 `Session.status` 标记为 `completed`，并推送 `complete` 事件。

### 4. 审稿（Reviewing）

- Worker：`src/workers/refiner.ts`
- Langfuse Prompt：`wash-review-{lang}`

支持两种用法：

1. **Auto-Review（自动审稿 + 自动重写）**：
   - 在生成时 `autoReview: true`；
   - 每生成一个节点，立刻创建一个 `reviewing` Job（`nodeId` 模式），异步调用 LLM 进行打分；
   - Review 完成后通过 SSE `log` 事件发送：`{ nodeId, score, issues }`；
   - 当 `autoFix == true` 且 `score <= 3` 时，自动：
     - 将该节点状态重置为 `generating`；
     - 将 `rerollCount` + 1；
     - 向 `generating` 队列添加一个新的单节点重写 Job（`autoReview: true`），形成「生成 → 审稿 → 低分重写 → 再审稿」的闭环。

2. **批量 Review（手动触发）**：
   - 路由：`POST /api/sessions/:id/review { autoFix: boolean }`；
   - Worker 会扫描所有 `status = completed` 且有内容的节点，按顺序逐个调用 LLM：
     - 每个节点完成时推送 `log` + `thought` 事件；
     - 若 `autoFix` 为 true 且评分过低，也会触发自动重写；
   - 完成后发送一条 `complete` 事件，`data.reviews` 中包含所有节点的评分统计（平均分、低分数量等）。

前端在工作台中以完全异步的方式呈现审稿结果：

- 左侧节点列表：在每个节点条目右侧显示 `★{score}`；
- 中心编辑器顶部：显示选中节点的 `评分：x/5`；
- 右下角「Review 结果」面板：持续累积最近的评分与问题摘要（不会等待整批结束）。

### 5. 导出（Export）

- 路由：`GET /api/sessions/:id/export`
- 实现：`src/routes/export.ts`

导出规则：

- 遍历所有 `status = 'completed'` 且 `content` 非空的节点；
- 生成压缩包，文件名格式：

```text
{三位序号}_{简短标题}_{highlight|normal}.md
# 例：
001_初遇危机_highlight.md
002_学院日常_normal.md
```

---

## Langfuse Prompt 管理

本项目所有 Prompt 统一托管在 **Langfuse** 中，运行时只通过 `src/lib/langfuse.ts` 访问，
具体使用与修改规范见 `LANGFUSE_PROMPTS.md`。

### 环境变量

确保 `.env` 中配置了：

```bash
LANGFUSE_SECRET_KEY=your_langfuse_secret
LANGFUSE_PUBLIC_KEY=your_langfuse_public
LANGFUSE_BASE_URL=https://cloud.langfuse.com  # 或你的自建实例
```

### Prompt 管理脚本总览

所有 Prompt 定义集中在 `scripts/` 目录下的 TS 脚本中，并通过 `langfuse.createPrompt` 进行 upsert：

- 基础索引 / 规划 / 生成：`scripts/upload_prompts.ts`
- 规划主流程：`scripts/upload_planning_prompts.ts`
- 规划蝴蝶效应微调：`scripts/upload_planning_butterfly_prompts.ts`
- Review 严格评分：`scripts/upload_review_prompts.ts`
- 支线相关：`scripts/upload_branching_prompts.ts`
- 角色映射：`scripts/upload_characters_prompt.ts`
- 节点角色改名：`scripts/upload_rename_prompts.ts`

### 推荐工作流（非常重要）

1. **修改前先下载快照**：

   ```bash
   cd reconstruction_project
   npx tsx scripts/download_prompts.ts
   ```

   生成的 `prompts_snapshot.json` 仅用于本地对比，已加入 `.gitignore`，不要提交到仓库。

2. **在 `scripts/upload_*.ts` 中调整对应 Prompt 定义**（system/user/assistant 内容、config 等）。
3. **通过脚本上传变更**，例如：

   ```bash
   # 更新规划相关 Prompt（wash-planning-*）
   npx tsx scripts/upload_planning_prompts.ts

   # 更新支线相关 Prompt（wash-branch-plan / events / write）
   npx tsx scripts/upload_branching_prompts.ts

   # 更新 Review / 角色相关 Prompt
   npx tsx scripts/upload_review_prompts.ts
   npx tsx scripts/upload_characters_prompt.ts
   npx tsx scripts/upload_rename_prompts.ts
   ```

4. **绝不在脚本中删除线上 Prompt**：如需废弃，通过 labels 或停用调用来实现。

更详细的规则（只能“添加/修改”而不能整体推倒重来、禁止删除线上 Prompt 等）
请参见根目录的 `LANGFUSE_PROMPTS.md`。

---

## 本地开发与运行

### 1. 环境依赖

- Node.js >= 20
- PostgreSQL 13+
- Redis 6+

### 2. 配置 `.env`

示例：

```bash
# Database
DATABASE_URL=postgresql://wash:wash@localhost:5432/wash?schema=public

# Redis
REDIS_URL=redis://localhost:6379

# LLM (DeepSeek via OpenAI SDK)
DEEPSEEK_API_KEY=your_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL_CHAT=deepseek-chat
DEEPSEEK_MODEL_REASONING=deepseek-reasoner

# Langfuse - Prompt Management & Observability
LANGFUSE_SECRET_KEY=your_langfuse_secret
LANGFUSE_PUBLIC_KEY=your_langfuse_public
LANGFUSE_BASE_URL=https://cloud.langfuse.com

# Worker Configuration
WORKER_CONCURRENCY_INDEX=5
WORKER_CONCURRENCY_GENERATE=3
WORKER_CONCURRENCY_REVIEW=5

# Server Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# Language
NOVEL_LANGUAGE=cn
```

---

## 生产部署（Docker Compose）

### 1. 配置生产环境变量

```bash
cp .env.production.example .env.production
# 编辑 .env.production，填入 LLM / Langfuse 等密钥
```

### 2. 一键启动（构建 + 运行）

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### 3. 访问入口（默认冷门端口）

- Web UI：http://localhost:31801
- API：http://localhost:31800

> 容器内部固定端口：API=8000、Web=8001；如需改外部端口，修改 `.env.production` 中的 `API_HOST_PORT` / `WEB_HOST_PORT`。
