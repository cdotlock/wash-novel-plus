# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project overview

This repo implements **Wash Novel Plus / Wash 2.0**, an event-driven pipeline that converts long-form web novels into a sequence of playable narrative nodes.

High-level stages (see `README.md` for more detail):
- **Indexing**: summarize each chapter, extract characters and key events, and classify chapter type (highlight/normal).
- **Planning**: plan event nodes over chapter ranges (auto/split/merge/one-to-one modes) with a target node count.
- **Generating**: turn each planned event into a playable node (Markdown text + choices), maintaining global memory.
- **Reviewing**: score generated nodes, surface issues, and optionally auto-reroll low-quality nodes.
- **Exporting**: bundle completed nodes into Markdown files inside a ZIP.

The system is split into:
- **API server** (`src/`): Fastify REST API, SSE endpoints, and orchestration.
- **Workers** (`src/workers/`): BullMQ workers for long-running LLM tasks.
- **Web workbench** (`web-ui/`): React/Vite SPA that drives the pipeline end-to-end.

## Runtime & environment

Core dependencies (also documented in `README.md` and `.env.example`):
- **Node.js**: >= 20 (see `package.json` → `engines.node`).
- **Database**: PostgreSQL (see `docker-compose.yml`, `prisma/schema.prisma`).
- **Queue/Cache**: Redis (used by BullMQ and SSE event fan-out).
- **LLM**: DeepSeek via the OpenAI-compatible SDK, configured via env.
- **Prompt management & tracing**: Langfuse for all LLM prompt templates.

Key env vars (see `.env.example`):
- `DATABASE_URL`, `REDIS_URL`.
- `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL_CHAT`, `DEEPSEEK_MODEL_REASONING`.
- `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL`.
- `WORKER_CONCURRENCY_INDEX`, `WORKER_CONCURRENCY_GENERATE`, `WORKER_CONCURRENCY_REVIEW`.
- `PORT`, `HOST`, `NODE_ENV`.
- `NOVEL_LANGUAGE` (`"cn"` or `"en"`) — controls which `*-{lang}` Langfuse prompts are used and the UI language default.

`docker-compose.yml` provides Postgres and Redis with reasonable local defaults; `DATABASE_URL` in `.env.example` is already set to point at those containers.

## Backend architecture (API + workers)

### Entry points & configuration

- **API server**: `src/index.ts`
  - Creates a Fastify app, registers CORS, global error handler (including Zod errors), and all route modules from `src/routes/index.ts`.
  - Validates configuration via `validateConfig()` and ensures a Prisma DB connection before listening.
  - Listens on `config.server.host:config.server.port` (defaults from env or `src/config/index.ts`).
- **Worker bootstrap**: `src/workers/index.ts`
  - Starts BullMQ workers for each queue (`INDEXING`, `PLANNING`, `GENERATING`, `REVIEWING`) with configured concurrency.
  - Handles graceful shutdown and logs failed/stalled jobs.
- **Configuration**: `src/config/index.ts`
  - Centralizes DB, Redis, LLM, worker, server, and language settings.
  - `validateConfig()` currently warns if `DEEPSEEK_API_KEY` is missing.

### Data model (Prisma)

`prisma/schema.prisma` defines the main persistence model:
- **Session**
  - Core unit of processing for a single novel run.
  - Fields (JSON-heavy):
    - `chapters`: raw chapter texts (`Record<number, Chapter>`).
    - `chapterIndex`: structured `ChapterIndex[]` from indexing.
    - `planEvents`: `EventPlan[]` from planning.
    - `nodes`: `Record<number, Node>` representing generated nodes.
    - `globalMemory`: serialized narrative/world-state memory.
    - `contentAnalysis`: aggregate statistics and metadata (e.g. recommended mode, node counts).
  - Other metadata: `status`, `planMode`, `planConfirmed`, timestamps.
- **Task**
  - Represents a long-running background operation: `indexing | planning | generating | reviewing`.
  - Tracks `status`, `progress`, `total`, `result`, `error`, `context`, and `bullJobId`.
- **TaskEvent**
  - Append-only log stream for tasks (`progress | log | error | complete | thought`).
  - Used to back SSE event streams consumed by the frontend.

### Libraries & infrastructure

- **Prisma client**: `src/lib/prisma.ts`
  - Singleton Prisma client with reduced logging in dev, reused via `globalThis`.
- **Redis & Pub/Sub**: `src/lib/redis.ts`
  - Shared `redis` client with reconnection, plus `createSubscriber()` for separate Pub/Sub connections.
  - Channel naming helpers under `channels.*` and a `publishEvent()` helper that wraps payloads with timestamps.
- **Queues & jobs**: `src/lib/queue.ts`
  - Declares BullMQ queues (`washFlow`, `indexing`, `planning`, `generating`, `reviewing`) bound to a dedicated Redis connection.
  - Provides `createWorker`, `getQueueEvents`, `addJob`, and `closeQueues()`.
  - Defines job payload types: `IndexingJobData`, `PlanningJobData`, `GeneratingJobData`, `ReviewingJobData`.
- **LLM client & routing**: `src/lib/llm.ts`
  - Wraps the OpenAI client pointed at DeepSeek.
  - `MODEL_ROUTER` maps logical roles (`indexer`, `planner`, `writer`, `refiner`) to model types (`chat` vs `reasoning`).
  - `chat`, `chatStream`, and `chatWithRetry` provide basic completion APIs with exponential backoff on 429s.
- **Langfuse integration**: `src/lib/langfuse.ts`
  - All prompts are fetched from Langfuse using `PROMPT_NAMES` such as `wash-indexing`, `wash-planning-*`, `wash-generate`, `wash-memory`, `wash-review`.
  - `getIndexingPrompt`, `getPlanningPrompt`, `getPlanningAdjustPrompt`, `getWashPrompt`, `getMemoryPrompt`, `getReviewPrompt` resolve the correct `{baseName}-{lang}` prompt and compile it with variables.
  - Prompts are cached in-memory with a short TTL.
- **LLM JSON handling**: `src/lib/json-utils.ts`, `src/schemas/llm-responses.ts`
  - `parseJsonSafe`, `tryParseJson`, `parseJsonLoose` use `jsonrepair` and Zod schemas to robustly parse LLM output.
  - Schemas define shapes for indexing responses, planning events, review results, etc.

### API routes

All HTTP routes live under `src/routes/` and are registered in `src/routes/index.ts`. Key groups:

- **Health & config**
  - `health.ts`: `/health`, `/health/detailed` checks DB and Redis.
  - `config.ts`: `/api/config` exposes language + selected LLM models to the frontend.

- **Sessions & nodes** (`sessions.ts`)
  - CRUD for `/api/sessions` and `/api/sessions/:id`.
  - `/api/sessions/:id/nodes` and `/api/sessions/:id/nodes/:nodeId` expose node lists and individual node editing.
  - Uses `parseJsonField` to normalize Prisma JSON fields that may be stored as either strings or native JSON.

- **Upload & chapter preparation** (`upload.ts`)
  - Handles the initial chapter upload for a session and optional auto-splitting of a single long file.
  - Frontend also calls `/api/preview-split` for a pre-upload chapter split preview.

- **Indexing** (`indexing.ts`)
  - `/api/sessions/:id/index` creates a `Task` and enqueues an `INDEXING` job.
  - `/api/sessions/:id/index/status` returns latest task status and recent events.
  - `/api/tasks/:taskId/events` opens an SSE stream using `createJobEventStream()`.

- **Planning** (`planning.ts`)
  - `/api/sessions/:id/plan` (POST) starts a planning task with optional mode/target/custom instructions/model.
  - Prevents concurrent planning for the same session (`pending` or `running` tasks).
  - `/api/sessions/:id/plan` (GET/PATCH) returns or updates `planEvents`, and PATCH with `confirmed: true` materializes `nodes` from events and marks the session as `confirmed`.

- **Generation** (`generating.ts`)
  - `/api/sessions/:id/generate` enqueues a `GENERATING` task (all nodes or a single node), optionally with `autoReview`.
  - Status endpoint returns task progress plus per-node statuses.
  - Cancel endpoint removes active jobs and marks the task as `cancelled`.

- **Review** (`review.ts`)
  - `/api/sessions/:id/review` enqueues a batch `REVIEWING` task for completed nodes; workers can also be asked to review a single node.

- **Export** (`export.ts`)
  - `/api/sessions/:id/export` streams a ZIP built with `archiver`. Each completed node becomes a `NNN_title_{highlight|normal}.md` file.

- **Session control** (`control.ts`)
  - Pause/resume endpoints toggle a Redis `pause:{sessionId}` flag and publish session events.
  - Reroll endpoint resets a node to `pending` and pushes a targeted `GENERATING` job.
  - `/api/sessions/:id/status` aggregates high-level status and simple node counts (total/completed/currently generating).

### SSE & event streaming

- Implemented in `src/sse/event-stream.ts` using Redis Pub/Sub and Fastify replies.
- Two main patterns:
  - **Task event stream** (`/api/tasks/:taskId/events`): job-specific channel used for indexing, planning, generating, and review logs.
  - **Session event stream** (`/api/sessions/:sessionId/events`): higher-level session events (pause/resume, node_start, etc.).
- Both streams periodically emit heartbeat events to keep connections alive and close when they receive a `complete`/`error` event.

### Workers & pipeline stages

- **Indexer** (`src/workers/indexer.ts`)
  - Reads `session.chapters`, sorts them, and processes chapters in small batches.
  - For each chapter: builds an indexing prompt via Langfuse, calls the LLM, validates/parses with `IndexingResponseSchema`, and falls back to heuristic summaries on errors.
  - Populates `Session.chapterIndex` and `Session.contentAnalysis` (including `recommendedMode` and `targetNodeCount`), then moves session status to `planning`.

- **Planner** (`src/workers/planner.ts`)
  - Uses `chapterIndex` and existing `contentAnalysis` to determine effective mode and target node count.
  - For `one_to_one` mode, deterministically maps each chapter to an event.
  - For AI modes (`auto`, `split`, `merge`): builds a compound chapter summary string and calls Langfuse planning prompts, using `parseJsonLoose` + repair heuristics to normalize events.
  - Stores normalized `planEvents`, rationale, updated `contentAnalysis` (including `lastPlanEventCount` / `lastPlanUserTarget`), and completes the `planning` task.

- **Writer** (`src/workers/writer.ts`)
  - Given a `GENERATING` job, loads session `chapters`, `nodes`, and `globalMemory`.
  - Selects nodes to process (all, from a certain ID, or a single node), skipping already-completed nodes for bulk jobs.
  - For each node:
    - Emits `node_start` / `thought` events.
    - Builds `chapterContent` for the node’s chapter range and a `wash-generate` prompt via Langfuse.
    - Calls the LLM, cleans Markdown code fences, and stores the resulting node `content` + status `completed`.
    - Builds a `wash-memory` prompt to update `globalMemory` using a cheaper chat model.
    - Optionally enqueues an auto-review job for the node.

- **Refiner** (`src/workers/refiner.ts`)
  - For batch or single-node review, constructs Langfuse `wash-review` prompts per node and parses results with `ReviewResponseSchema`.
  - Updates `qualityScore` on nodes and publishes fine-grained review logs and thought events.
  - If `autoFix` is enabled and score is low, can trigger reroll jobs in the generating queue and increment per-node reroll counts.

## Frontend architecture (`web-ui/`)

The frontend is a Vite + React SPA (`web-ui/src/App.tsx`) driven by a high-level `step` state:
- `upload` → file selection, optional auto-splitting of a single file into chapters, session creation, and initial upload.
- `split-preview` → preview and manual pruning of auto-detected chapters before committing.
- `indexing` → progress bar for indexing, driven by SSE events from `/api/tasks/:taskId/events`.
- `planning` → event list editor with planning mode/target controls and re-plan support.
- `executing` → integrated “workbench” view with node list, node editor, thought stream, and review results.

Important details:
- `API_BASE` is hard-coded to `http://localhost:3000`; the backend should expose its API there in local development.
- The app restores the last session from `localStorage` (`wash_session`) and then re-syncs plan/nodes from the server using `/api/sessions/:id/plan` and `/api/sessions/:id/nodes`.
- SSE:
  - Subscribes to `/api/tasks/:taskId/events` to drive progress, logs, thought stream, node-level updates, and task-complete transitions between stages.
  - Uses `node_start`, `node_ready`, `log`, `progress`, `reroll`, `complete`, `error`, and `paused` events to keep the UI reactive.
- Manual interventions:
  - Users can edit event ranges and descriptions in the planning view and patch them back when confirming.
  - In the executing view, users can edit generated node content, reroll individual nodes, pause/resume generation, and trigger batch review if auto-review is off.

## Common commands (backend)

From the repo root:

### Install & setup
- Install deps: `npm install`
- Generate Prisma client: `npm run db:generate`
- Apply schema to the database (non-destructive): `npm run db:push`
- Run interactive migrations: `npm run db:migrate`
- Inspect DB via Prisma Studio: `npm run db:studio`

To bring up Postgres + Redis locally (matching `.env.example`):
- `docker-compose up -d`

### Run API & workers
- Development API server (Fastify + TSX watch):
  - `npm run dev`
- Production-style server (after a build):
  - `npm run build`
  - `npm start`
- Background workers:
  - `npm run worker` (start all workers as a single process).
  - `npm run worker:dev` (same with TSX watch for live reload during development).

### Testing & quality
- Run all tests (Vitest):
  - `npm test`
- Run subset of tests:
  - `npm run test:db`
  - `npm run test:queue`
  - `npm run test:api`
- Run a single test file (standard Vitest usage):
  - `npm test -- path/to/file.test.ts`
- Lint backend TypeScript:
  - `npm run lint`
- Format backend sources:
  - `npm run format`

### Prompt management (Langfuse)

All core prompts are managed via scripts under `scripts/` and Langfuse:
- Upload the full prompt set (indexing/planning/generate/memory/review, CN+EN):
  - `npx tsx scripts/upload_prompts.ts`
- Upload or refresh only planning-related prompts (including `wash-planning-adjust-{lang}`):
  - `npx tsx scripts/upload_planning_prompts.ts`
- Upload or refresh review prompts (`wash-review-{lang}`) using the stricter review schema:
  - `npx tsx scripts/upload_review_prompts.ts`

These scripts expect Langfuse env vars to be set (see `.env.example`).

## Common commands (frontend `web-ui/`)

From `web-ui/`:
- Install deps: `npm install`
- Development server (Vite): `npm run dev`
- Build: `npm run build` (TypeScript build + Vite build)
- Lint: `npm run lint`
- Preview production build: `npm run preview`

The frontend expects the backend API at `http://localhost:3000` (adjust `API_BASE` in `App.tsx` if you change the backend host/port).

## End-to-end flow summary

A typical local flow for this repository is:
1. **Start infrastructure**: `docker-compose up -d` for Postgres + Redis; ensure `.env` (or `.env.example` copy) is in place.
2. **Start services**:
   - In one terminal: backend API via `npm run dev`.
   - In another: workers via `npm run worker`.
   - In `web-ui/`: `npm run dev` for the React workbench.
3. **Prepare Langfuse** (once per environment): ensure all `wash-*` prompts have been uploaded via the prompt scripts and that `LANGFUSE_*` env vars are valid.
4. **Use the web UI**:
   - Upload or auto-split a novel.
   - Start indexing; the UI will attach to `/api/tasks/:taskId/events` and move to planning on completion.
   - Run planning, adjust events if needed, then confirm to materialize nodes.
   - Start generation with optional auto-review; monitor nodes, reroll as necessary.
   - Export completed nodes via the "Export ZIP" action (calls `/api/sessions/:id/export`).

Understanding the separation between **Fastify routes**, **Prisma models**, **BullMQ workers**, **Redis/SSE messaging**, **Langfuse-managed prompts**, and the **React workbench** is the key to making deep changes in this codebase productively.
