# Architectural decisions

Accepted decisions only. New decisions are appended; superseded ones are marked, not deleted.

## ADR-001: Modular monolith with consolidated packages
The original plan listed ~18 packages. Packages that would only hold one module, or that
have no independent consumer, were merged to keep interfaces clear without boundary churn:

| Planned | Implemented in |
|---|---|
| dag-scheduler, workflow-engine, agent-router, agent-registry, context-compiler, policy-engine, event-bus | `engine-kernel` (`dag.ts`, `scheduler.ts`, `workflows.ts`, `router.ts`, `context.ts`, `events.ts`); adapter registry in `execution-runtime` |
| knowledge-graph | `shared-memory` (relations + one-hop traversal) |
| sdk | not built; the REST API + OpenAPI document is the integration surface |

Provider logic stays in `adapters/*`; the kernel only sees the `AgentAdapter` contract.

## ADR-002: Embedded PGlite for dev/test, real Postgres for production
PGlite (with pgvector) is exposed over the Postgres wire protocol by our own server
(`packages/database/src/dev-server.ts`). Batches run atomically per protocol boundary, and a
connection inside a transaction owns the backend, so `pg`/Drizzle behave as they would
against a server. `@electric-sql/pglite-socket` was rejected because it interleaves
extended-protocol messages under concurrency. Production uses `docker-compose.yml`
(`pgvector/pgvector:pg17`). The same migrations run on both.

## ADR-003: bubblewrap is the security boundary, worktrees are not
Agent and validation processes run under `bwrap`: read-only `/`; tmpfs over `$HOME`, `/tmp`,
`/run`; only the worktree (rw), the git common dir (ro), the provider state dir (rw: `~/.claude`,
`~/.codex`), the scratch dir and the binaries are bound. Validation commands run without
network. `AGENTMESH_SANDBOX=none` exists for hosts without bwrap and is unsafe.

## ADR-004: Durable event table + SSE polling instead of a broker
All events are rows in `events`; SSE streams poll by id (Last-Event-ID resume). This works
across processes and restarts with no Redis or LISTEN/NOTIFY. It costs a ~200–500 ms latency.

## ADR-005: Integration through an isolated worktree and a CAS ref update
Approval merges the exact validated head SHA in a throwaway worktree, re-runs validation on
the merge result, then advances the target with `update-ref <new> <old>`, or with
`merge --ff-only` if the target is checked out and clean. A user's dirty checkout is never touched.

## ADR-006: Run-scoped agent credentials and a stateless MCP proxy
Each run gets an `amr_` token (hashed in `agent_sessions`) that is valid only while the run is
`running`, only on `/api/v1/agent-tools/*`, and is revoked at run end. The MCP server reads it
from a 0600 file in the sandboxed scratch dir, so it never appears in argv. MCP tool names
use `_` (`knowledge_publish`) because tool names cannot contain dots.

## ADR-007: Deterministic hashing embedder behind an `Embedder` interface
Semantic search uses pgvector over a local feature-hashing embedder (256 dims, unigrams +
bigrams). It is reproducible and needs no credentials. It is a lexical-semantic signal, not a
neural embedding; a neural provider can be plugged in with the same dimensions (requires a
re-embed migration if the dimensions change).

## ADR-008: Knowledge trust rules
Agent output is always stored as `proposed`/`evidenced`. Agents may verify or dispute only
records from *other* agents, and only with evidence. Architectural decisions become
authoritative only by human acceptance. Stale records must be revalidated (by a human, back
to `proposed`) before verification. Supersession takes effect only when the replacement is
verified or accepted. Context packs include only non-excluded statuses, labelled by trust,
inside data fences.

## ADR-009: Workflow approval nodes are gates, not tasks
An approval node marks every upstream code-modifying task `requiresApproval`; it is not
materialised as a task. The "Merge" step is the integration that approval triggers.
Conditional edges (`success|failure|always`) are stored per dependency and evaluated by the
scheduler. A branch that is not taken is cancelled with a reason; a failed success-edge blocks.

## ADR-010: Portal holds the API token server-side
The browser never sees a token. It calls the same-origin `/api/proxy/v1/*` route, which
attaches the server's token, allow-lists API groups, and requires same-origin + JSON for
mutations (CSRF). The portal binds to 127.0.0.1. Multi-user portal login is not in scope (see KNOWN_ISSUES).

## ADR-011: Antigravity integration mode is "assisted"
`agy` 1.5.2 is detected and reports print/stream-json and ACP modes, but AgentMesh has not
verified its event schema or sandbox behaviour. The adapter reports `assisted`; routing
never assigns it unattended work, and execution returns `capability_unavailable`.
Deterministic browser checks use Playwright (portal e2e suite, and project validation
commands can run Playwright).

## ADR-012: Codex MCP tools are auto-approved for the AgentMesh server only
`codex exec` runs with approval policy `never`, which rejects MCP tool calls that need
approval (observed live). The adapter sets
`mcp_servers.agentmesh.default_tools_approval_mode="approve"` (valid values on codex 0.167:
`auto|prompt|writes|approve`). Other MCP servers are not loaded.
