# Architecture

Modular monolith with independently executable processes, all backed by one PostgreSQL database.

```
 Browser ──► apps/web (Next.js) ──/api/proxy──► apps/api (Fastify, /api/v1) ──┐
                 (server-held token)              │  REST + SSE + OpenAPI    │
                                                  │                          ▼
 Agent CLI (in bwrap) ──MCP stdio──► agentmesh-mcp ──► /api/v1/agent-tools ─► PostgreSQL
   claude / codex                    (run token)                              (+pgvector, FTS)
        ▲                                                                       ▲
        └──── apps/worker: lease → worktree → context → sandboxed run → gates ──┘
```

## Processes

| Process | Entry | Role |
|---|---|---|
| API | `apps/api/src/main.ts` | REST `/api/v1`, SSE, OpenAPI, auth, approvals/integration |
| Worker (N) | `apps/worker/src/main.ts` | recovery, scheduling (promote → route → lease), execution |
| Portal | `apps/web` | UI. Browser talks only to its same-origin proxy |
| CLI | `apps/cli/src/index.ts` | embedded DB, migrations, tokens, seeding, bootstrap |
| MCP server | `packages/mcp-server` (bundled to one file) | spawned by agent CLIs inside the sandbox |

Workers coordinate only through the database: leases are compare-and-swap updates, agent
concurrency is enforced under a row lock on the agent, and events are rows in `events`.

## Packages

| Package | Responsibility |
|---|---|
| `contracts` | Zod schemas and types shared by the API, engine, portal and MCP: task state machine, adapter contract, knowledge, workflow graph, collaboration operations |
| `database` | Drizzle schema, migrations, pg client, embedded PGlite wire server for dev/test |
| `engine-kernel` | TaskService (lifecycle via `transition()`), DAG validation, scheduler (promote/lease/heartbeat/reconcile), router, context compiler, executor, approvals/integration, collaboration, workflows, Worker loop |
| `shared-memory` | KnowledgeService: publish/dedupe/scope/verify/stale, hybrid search, subscriptions, consumption tracking; embedder; path overlap |
| `execution-runtime` | process runner (process groups, timeouts, abort), bwrap sandbox, env allow-list, adapter registry |
| `workspace-manager` | repo validation, worktrees, scope checks, commit, isolated integration with CAS ref update |
| `validation-engine` | sandboxed command quality gates |
| `mcp-server` | MCP tools → API proxy; esbuild bundle |
| `observability` | pino logger, secret redaction |
| `adapters/*` | provider-specific CLI integration (no provider logic in the kernel) |

## Task lifecycle

`PENDING → READY → LEASED → RUNNING → VALIDATING → COMPLETED`, plus `BLOCKED`, `FAILED`,
`CANCELLED`, `RETRY_WAIT`, `AWAITING_APPROVAL`. The legal transitions table is in
`packages/contracts/src/task-state.ts`. Every change goes through `transition()` under
`SELECT … FOR UPDATE`, which also writes a `task.status` event.

Execution of a leased task (`executor.ts`):
1. Idempotent run row per (task, attempt) → RUNNING.
2. Worktree from the default branch (or, for read-only tasks depending on one validated
   change, that change's head commit).
3. Run-scoped agent session (token, revoked at the end) and the MCP server registration.
4. Context snapshot (immutable, hashed, budgeted; knowledge sections labelled by trust).
5. Adapter run inside bwrap. Heartbeats extend the lease; a lost lease, pause or cancel aborts.
6. Quality gates: agent result, read-only or file-scope + protected paths + symlink escape,
   plan schema, then commit and project validation commands (sandboxed, no network).
7. `COMPLETED` (read-only) or `AWAITING_APPROVAL` (code). Plans materialise child DAGs.

A successful process exit is never treated as completion on its own.

Integration (`approvals.ts`): human approval of the exact validated head → merge in a
throwaway integration worktree → integration validation → atomic `update-ref` CAS (or
`--ff-only` when the target is checked out and clean) → knowledge staleness marking.

## Shared knowledge fabric

`knowledge_records` (+ evidence, relations, consumption, subscriptions). The lifecycle:

```
proposed ──evidence──► evidenced ──independent verify──► verified ──human──► accepted
   ▲                                                         │
   └──── revalidate (human) ◄── stale (affected code changed) ◄┘   disputed / rejected / superseded
```

- Agents can never self-verify, accept, or reject. Architectural decisions become
  authoritative only through human acceptance.
- Retrieval applies authorization (project, per-agent visibility, task scope) and freshness
  (excluded statuses) **before** ranking. Ranking: FTS rank, cosine similarity (pgvector),
  path overlap, dependency chain, one-hop relations, weighted by trust and recency, with
  deterministic tie-breaks.
- Context packs separate *Accepted decisions & contracts*, *Verified knowledge*, and
  *Unverified discoveries (provisional)*. All of them are wrapped in `<context-data>` fences
  that the content cannot close; knowledge is never treated as instructions.
- Each delivery is recorded (`knowledge_consumption`: record version, task, run, agent, snapshot, via).

## Collaboration

Agents call operations via MCP (`knowledge_publish`, `knowledge_search`, `knowledge_get`,
`knowledge_subscribe`, `knowledge_verify`, `context_refresh`, `agent_requestHelp`,
`agent_requestReview`, `task_propose`, `task_getStatus`, `task_reportFinding`). The MCP server
holds no privileges: it forwards to `/api/v1/agent-tools/:op` with a run-scoped token read
from a 0600 file. Help and review requests create traceable tasks (origin, requester, depth ≤ 2,
≤ 5 per run, idempotent per run). Proposals land in the backlog for a human.

## Workflows

`WorkflowGraph` (contracts) is both the builder's document and the executable definition.
`compileWorkflow()` validates it (ids, edges, cycles, branch rules) and collapses
approval/start/end nodes. Running a workflow creates the whole task DAG in one transaction,
with per-edge conditions (`success | failure | always`) that the scheduler evaluates. A branch
that is not taken is cancelled with a reason; a failed success-edge blocks the task.

## Security model (summary)

Bearer tokens (sha256-hashed, roles admin/operator/viewer, optional project scope); separate
run-scoped agent tokens that only work on `/agent-tools` while the run is live; every
mutation is audited; rate limiting; repo path validation (absolute, realpath, repo root,
allowed roots, not overlapping the data dir); bwrap sandbox with `$HOME`, `/tmp` and `/run`
replaced by tmpfs and only the needed paths bound; env allow-list plus per-agent secret env
references (names only); redaction of secrets in events, logs and artifacts; approval gates;
CSRF protection on the portal proxy.
