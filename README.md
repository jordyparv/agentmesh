# AgentMesh

Local-first orchestration engine and web control center for AI coding agents (Claude Code,
OpenAI Codex, Google Antigravity, and future adapters) that collaborate on a Git repository
through a **shared, verified knowledge fabric**: a structured, deterministic engine, rather than
three CLIs running side by side.

- **Engine kernel**: task DAGs, a legal state machine, transactional leasing with heartbeats
  and recovery, capability routing, concurrency limits, retries, pause/cancel, quality gates,
  and approval-gated integration.
- **Execution isolation**: one git worktree per task attempt, run inside a bubblewrap sandbox
  with an allow-listed environment. File scope, protected paths and symlink escapes are
  enforced before anything is committed.
- **Shared intelligence**: knowledge records with provenance, evidence, dedupe, scope,
  verification rules, staleness on code change, and hybrid retrieval (PostgreSQL full-text +
  pgvector + paths + dependencies + relations). Immutable context snapshots per run.
- **Collaboration**: an MCP server (`agentmesh`) with `knowledge.*`, `context.refresh`,
  `agent.requestHelp/requestReview`, `task.propose/getStatus/reportFinding`. These calls are
  scoped to the run, audited, and bounded in depth.
- **Control Center** (Next.js): dashboard, task board, live task detail (SSE), review
  center, shared memory explorer, visual workflow builder, agent and project management.

> Status and verification evidence: [`docs/ai/IMPLEMENTATION_STATUS.md`](docs/ai/IMPLEMENTATION_STATUS.md).
> Known limitations: [`docs/ai/KNOWN_ISSUES.md`](docs/ai/KNOWN_ISSUES.md).

## Requirements

Node.js 22+, pnpm, git ≥ 2.38, bubblewrap (`bwrap`) for sandboxing. Optional: Docker for the
production-like Postgres, and the agent CLIs you want to use (`claude`, `codex`, `agy`), already
authenticated.

## Quick start (local)

```bash
pnpm install
pnpm db:serve                 # terminal 1: embedded Postgres (PGlite + pgvector) on :54329, data in .data/pg
pnpm agentmesh bootstrap      # migrate, load workflow templates, register+probe installed agents,
                              # create a portal admin token in apps/web/.env.local (mode 600)
pnpm dev:api                  # terminal 2: API on http://127.0.0.1:4000 (OpenAPI: /api/v1/openapi.json)
pnpm dev:worker               # terminal 3: worker (sandboxed agent execution)
pnpm dev:web                  # terminal 4: portal on http://127.0.0.1:3000
```

Then, in the portal: **Projects → Register repository** (absolute path to a git repo), **Tasks → New task**,
assign Claude Code or Codex (or leave it on automatic), check *Start when dependencies are
satisfied*, and watch it run live. Approve or reject the result in **Reviews**.

Production-like Postgres: `docker compose up -d`, then set
`DATABASE_URL=postgres://agentmesh:<password>@127.0.0.1:5432/agentmesh`.

Restrict which repositories can be registered with `AGENTMESH_ALLOWED_REPO_ROOTS=/home/me/code`
(colon-separated). See [`.env.example`](.env.example) for all settings.

## Tests

```bash
pnpm typecheck
pnpm test          # unit + integration (Vitest; embedded Postgres; real git, real bwrap sandbox, SIMULATED agents)
pnpm test:e2e      # browser tests (Playwright) against a real API + worker + portal, SIMULATED agents
pnpm test:live     # OPT-IN: real Claude Code + Codex runs (spends tokens)
```

Simulated runs use the `test` adapter, which spawns real sandboxed processes that follow
a script. It is disabled outside tests unless `AGENTMESH_ENABLE_TEST_ADAPTER=1`, and it is never
used as evidence that a live provider works.

## Layout

```
apps/        api (Fastify) · worker · web (Next.js) · cli
packages/    contracts · database · engine-kernel · shared-memory · execution-runtime ·
             workspace-manager · validation-engine · mcp-server · observability
adapters/    claude · codex · antigravity · test (simulated)
workflows/   engineering · bugfix · code-review · visual-qa templates
docs/ai/     canonical project documentation for humans and AI agents
tests/       integration · e2e (Playwright) · live (opt-in)
```

Package consolidation relative to the original plan is recorded in [`docs/ai/DECISIONS.md`](docs/ai/DECISIONS.md) (ADR-001).
