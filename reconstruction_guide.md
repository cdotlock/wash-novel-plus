# Wash 2.0 重构执行指令 (Production Edition)

## 1. 核心技术栈 (The Stack)

* **Language**: **Node.js (TypeScript)** 全栈。
  * *Python、Java 等 (Optional)*: 仅作为微服务存在
* **Database**: **PostgreSQL** (Prisma ORM)。用于持久化存储 (Session, Nodes, Finished Tasks)。
* **Queue & Cache**: **Redis** + **BullMQ**。
  * **Redis**: 负责 Pub/Sub (实时日志推送)、分布式锁 (Locking)。
  * **BullMQ**: 负责异步任务队列、并发控制、重试机制。这是“并行化多任务”的核心。
* **Backend**: **Fastify** 或 **NestJS** (推荐 Fastify 追求高性能，NestJS 追求规范)。

## 2. 架构：事件驱动的流水线 (Event-Driven Pipeline)

**目标**：彻底解耦，支持水平扩容 (Scaling)，任务状态与 Web 进程无关。

### A. 异步任务编排 (The Orchestrator)

* **Job 提交**：用户请求 -> API -> `jobsQueue.add('wash-flow', { payload })` -> 返回 JobID。
* **Flow 拆解**：
  * 不写在一个大函数里。使用 **BullMQ Flow** (父子任务) 或 **Saga 模式**。
  * 例如：`PlannerJob` 完成后，自动触发 N 个并行的 `WriterJob`。
* **Redis Pub/Sub 实时反馈**：
  * Worker 在处理任务时，不直接发 SSE。
  * Worker -> `redis.publish('job-events', { jobId, type: 'thought', content: '...' })`。
  * API Server 订阅 Redis 频道 -> SSE -> 前端。
  * **优势**：Worker 和 API Server 可以部署在不同机器上，互不影响。

### B. 并发控制 (Concurrency)

* 利用 BullMQ 的 `concurrency` 参数。
* **Planner/Indexer**: 设置 `concurrency: 5` (受限于 API 速率)。
* **DeepSeek-Reasoning**: 限制 `concurrency` 较低，防止过高成本或超时。

## 3. 鲁棒性数据处理 SOP (JSON Pipeline)

**目标**：在 Node 环境下实现最强的容错解析。

* **Pipeline 实现**：
    1. **Raw Output**: 获取 LLM 字符串。
    2. **Regex Clean**: `const jsonStr = raw.match(/```json([\s\S]*?)```/)?.[1] || raw;`
    3. **Repair**: 使用 **`jsonrepair`** (npm package) 修复不合法的 JSON (如缺逗号、引号)。
    4. **Parse**: `JSON.parse()`。
    5. **Validate**: 使用 **Zod** 进行 Schema 校验。
        * `const ResultSchema = z.object({ ... })`
        * 如果 `ResultSchema.safeParse()` 失败，捕获 ZodError，自动触发重试 (BullMQ retry)。

## 4. 模型路由与缓存策略

**目标**：DeepSeek 双模型协同。

* **Model Router (TS Service)**:
  * **`DeepSeek-Chat` (V3)**: 用于 `Indexer` (索引)、`Summary` (摘要)。
  * **`DeepSeek-Reasoning` (R1)**: 用于 `Planner` (深度规划)、`Writer` (正文重构)、`Refiner` (精修)。
* **KV Cache 优化 (Prompt Structure)**:
  * 代码中利用 Template String 拼接：
  * `Prompt = [Static System Prompt] + [Static World Guide] + [Dynamic Chapter Content]`
  * 确保前 80% 的字符串在同一本书的任务中是字节级一致的，以命中云端缓存。

## 5. Manus 式交互体验 (UX)

**目标**：透明化、可干预。可以暂停、干预、重写，用户实时感知进程，并且写完一个就能看到一个，可以实时预览和编辑，可以针对单节点重新生成，也可以提出更多指令指导后续输出。

* **实时状态流 (State Streaming)**:
  * 前端建立 SSE 连接 `/api/stream?jobId=xyz`。
  * **Thought Stream**: 实时推送 `type: 'thought', delta: '正在构思打斗场景...'` (来自 R1 的思维链)。
  * **Result Stream**: 节点生成的瞬间，推送 `type: 'node_ready', node_id: 1`。
* **人机共驾 (Human-in-the-Loop)**:
  * **暂停/干预**: 前端点击“暂停” -> API 更新 Redis 中的 Job 状态 -> Worker 轮询检测到暂停信号 -> 挂起当前 Job。
  * **插入指令**: 用户输入指令 -> API 写入 DB `NextStepContext` -> 用户点击“继续” -> Worker 读取新 Context 继续生成。
  * **Hot Re-roll**: 点击重写 -> 清除 DB 中该 Node 数据 -> 触发 BullMQ `removeJob` 并重新 `addJob`。

## 6. 配置管理

* **Prompts**:
  * 所有 Prompt 运行时来源均为 **Langfuse**；
  * Prompt 定义集中在 `scripts/upload_*.ts` 中，通过脚本调用 Langfuse API (`langfuse.createPrompt`) 完成新增/修改；
  * 不再使用 `/src/prompts/*.hbs` 这类本地模板文件；
  * 任何改动必须遵守 `LANGFUSE_PROMPTS.md` 中的「先下载快照、只做 add/modify、不删线上 Prompt」规则。
* **Context**:
  * 使用 TS Interface 定义 Context 结构 (如 `IWorldState`, `ICharacterStatus`)。
  * 每次生成完，将 Context 存入 PG 的 `jsonb` 字段。

---

### 🚀 部署架构图 (Deployment View)

```mermaid
graph TD
    Client[Web Client] -->|HTTP/SSE| Gateway[Node API (Fastify)]
    Gateway -->|Enqueue| Redis[(Redis)]
    Gateway -->|Persist| PG[(PostgreSQL)]
    
    subgraph "Worker Cluster (Scalable)"
        W1[Node Worker 1]
        W2[Node Worker 2]
        W_Py[Python Service (Optional)]
    end
    
    Redis -->|Consume Job| W1
    Redis -->|Consume Job| W2
    W1 -->|Publish Log| Redis
    Redis -->|Sub Log| Gateway
    
    W1 -->|API Call| DeepSeek[DeepSeek API]
```

**执行优先级**：

1. **搭建 BullMQ + Redis + Fastify 骨架**，跑通“提交任务 -> Worker 执行 -> SSE 推送日志”的闭环。
2. **移植 JSON SOP** (Zod + JsonRepair)。
3. **接入 DeepSeek** 并实现 Router。

记得LLM和数据库服务不要暴露在前端，通过.env 文件配置。
请注意，一定要保证，你的所有代码文件都写在 reconstruction_project 文件夹下，直接从零到一完成整个新的系统的构建和开发。
