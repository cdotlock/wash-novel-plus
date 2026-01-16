# Langfuse Prompt 使用规范

本文件约束 **Wash Novel Plus / Wash 2.0** 在 Langfuse 上管理所有 Prompt 的统一规则。

> 核心目标：**Prompt 只有一个真实来源（Langfuse），所有修改都有脚本、可回溯，有最小化 diff。**

---

## 1. 总体原则

1. **所有 Prompt 的运行时来源都在 Langfuse**。
   - 代码中只通过 `src/lib/langfuse.ts` 的 `getPrompt(...)` / `getXXXPrompt(...)` 访问，
     不直接在业务代码里硬编码大段 Prompt 文本。
2. **所有 Prompt 的「定义」都在 scripts 目录的 TS 脚本中维护**。
   - 例如：
     - `scripts/upload_prompts.ts`
     - `scripts/upload_planning_prompts.ts`
     - `scripts/upload_planning_butterfly_prompts.ts`
     - `scripts/upload_review_prompts.ts`
     - `scripts/upload_branching_prompts.ts`
     - `scripts/upload_characters_prompt.ts`
     - `scripts/upload_rename_prompts.ts`
   - 不再维护 `prompts/*.hbs` 这类本地模板文件（已移除）。
3. **任何 Prompt 的新增 / 修改，都必须通过脚本调用 Langfuse API 完成**，
   不允许在 Langfuse Web UI 里直接手改到不可回溯。

---

## 2. 工作流程（Workflow）

### 2.1 修改前：先下载快照

在修改任何 Prompt 之前，必须先下载当前 Langfuse 上的 Prompt 快照：

```bash
cd reconstruction_project
npx tsx scripts/download_prompts.ts
```

该脚本会：

- 调用 Langfuse 的 `getPrompt` API，把我们关心的所有 Prompt（`wash-*` 系列）拉取下来；
- 将结果写入根目录：`prompts_snapshot.json`；
- 用于对比「改前 / 改后」的 Prompt 差异。

> 注意：`prompts_snapshot.json` 是**本地调试产物**，已经通过 `.gitignore` 忽略，
> 不应提交到 Git 仓库。

### 2.2 在脚本中编辑 Prompt 定义

根据需要编辑以下脚本之一（或新增脚本）：

- `scripts/upload_prompts.ts`：早期的索引/规划/生成基础 Prompt（如 `wash-indexing`、旧版 `wash-planning-*`、`wash-generate`、`wash-memory` 等）。
- `scripts/upload_planning_prompts.ts`：新版规划 Prompt（`wash-planning-auto/split/merge/adjust`）。
- `scripts/upload_planning_butterfly_prompts.ts`：蝴蝶效应微调 Prompt（`wash-planning-butterfly-{lang}`）。
- `scripts/upload_review_prompts.ts`：严格 Schema 的 Review Prompt（`wash-review-{lang}`）。
- `scripts/upload_branching_prompts.ts`：支线相关 Prompt（`wash-branch-plan/events/write-{lang}`）。
- `scripts/upload_characters_prompt.ts`：角色名合并 / 角色映射 Prompt。
- `scripts/upload_rename_prompts.ts`：节点内容角色改名 Prompt（`wash-rename-node-{lang}`）。

编辑规则：

- **只能增加或修改某个 Prompt 的定义**，不要「整段删掉再重写一个完全不相关的名字」。
- 统一通过 `langfuse.createPrompt({ name, prompt, config, isActive: true, type: 'chat', labels })` 进行 upsert：
  - 若该 `name` 不存在，则创建新 Prompt；
  - 若存在，则创建/更新一个新版本。
- 禁止脚本中调用任何 **删除 Prompt** 的 API。

### 2.3 通过脚本上传（应用 diff）

在脚本编辑完成后，通过对应脚本上传：

```bash
# 例如，仅更新规划相关 Prompt
npx tsx scripts/upload_planning_prompts.ts

# 更新支线相关 Prompt（wash-branch-plan / events / write）
npx tsx scripts/upload_branching_prompts.ts

# 更新 Review / 角色改名等
npx tsx scripts/upload_review_prompts.ts
npx tsx scripts/upload_rename_prompts.ts
npx tsx scripts/upload_characters_prompt.ts
```

脚本会：

- 遍历各自维护的 Prompt 集合；
- 对每个 Prompt 名调用 `createPrompt`，依赖 Langfuse 的版本管理；
- 输出 `✅ Created/updated ...` 日志，方便检查是否全部应用成功。

这些脚本可以在本地或 CI 中 **自动执行**，不需要手动登录 Langfuse 控制台操作。

---

## 3. 必须遵守的规则（关键约束）

**以下规则是对本项目中 Prompt 管理的硬性规范：**

1. **先下载再修改**
   - 在修改任何 Prompt 之前，必须先运行一次 `scripts/download_prompts.ts`，
     获取最新快照，避免在过期状态上改动。

2. **只允许「添加 / 修改」，不允许「整体推倒重来」**
   - 在脚本里修改 Prompt 时：
     - 针对某个 `name`，修改其 system / user / assistant 内容属于「修改」；
     - 新增一个新的 `name` 属于「添加」。
   - 不允许：
     - 删除整批 Prompt 再重新创建（无历史可查）；
     - 改名导致旧名字在 Langfuse 中「孤立」又没人维护。

3. **严禁删除线上 Prompt**
   - 不在任何脚本中调用删除 Prompt 的 API；
   - 如果需要废弃某个 Prompt：
     - 可以通过 `labels` 标记为 `deprecated`；
     - 或在代码层面停止使用该 Prompt 名称。

4. **新增 Prompt 必须通过脚本**
   - 新功能（例如新的支线模式、额外 Review 维度）需要新 Prompt 时：
     - 在 `scripts/upload_*.ts` 中添加对应定义；
     - 通过脚本上传，而不是在 Langfuse Web UI 中手动创建。

5. **脚本可以由 Agent / CI 直接运行**
   - 所有 `upload_*` / `download_prompts.ts` 脚本都设计为：
     - 幂等：重复运行不会破坏已有配置；
     - 无需人工干预：不需要交互式输入；
     - 可被 Agent 或 CI 流水线直接调用。

---

## 4. 代码层面的依赖关系

- 所有业务代码通过 `src/lib/langfuse.ts` 使用 Prompt 名称：
  - `PROMPT_NAMES.INDEXING = 'wash-indexing'`
  - `PROMPT_NAMES.PLANNING_AUTO = 'wash-planning-auto'`
  - `PROMPT_NAMES.BRANCH_WRITE = 'wash-branch-write'`
  - `PROMPT_NAMES.RENAME_NODE = 'wash-rename-node'`
  - 等等。
- 运行时会自动根据 `config.novelLanguage` 选择 `{baseName}-{lang}`，例如：
  - `wash-planning-auto-cn`
  - `wash-branch-write-en`
- Langfuse 端必须保证这些名字存在，否则会在 `getPrompt` 时抛出带有提示信息的错误。

> 若要新增 Prompt 名称，先在 `src/lib/langfuse.ts` 的 `PROMPT_NAMES` 中声明，
> 然后在对应的 `scripts/upload_*.ts` 中添加上传逻辑，最后通过脚本推送到 Langfuse。

---

## 5. 迁移与清理说明

- 旧版本地模板目录 `prompts/*.hbs` 已经废弃，不再作为 Prompt 源：
  - 不再从文件系统加载 `.hbs`；
  - 所有 Prompt 内容统一收敛到 `scripts/upload_*.ts` 中；
  - 运行时一律从 Langfuse 获取。
- 若在其他文档中仍提到 `src/prompts/*.hbs` 等路径，请以本文件为准，并逐步更新旧文档。

---

如需修改或扩展本规范，请同步更新：

- 本文件：`LANGFUSE_PROMPTS.md`
- 根目录 `README.md` 中的「Langfuse Prompt 管理」章节
- 以及 `reconstruction_guide.md` 中的相关说明。