# Implementation status

Last updated: 2026-11-07. Environment: Linux (Manjaro), Node 22.23, pnpm 12.18, git 2.56,
bubblewrap, Claude Code 2.1.319, codex-cli 0.167.0, agy (Antigravity) 1.5.2, Docker present
(not used by tests).

Legend: **Verified-live**: exercised with the real provider CLI. **Verified**: exercised by
automated tests with real processes, git, sandbox and DB, using the SIMULATED `test` adapter
for agent behaviour. **Partial / Not done**: see notes.

## Phases

| Phase | Status |
|---|---|
| 1 Foundation (monorepo, TS strict, Postgres + migrations, contracts, Fastify, portal shell, CRUD) | Verified |
| 2 Engine (state machine, DAG, persistence, registry, Codex + Claude adapters, worktrees, event streaming) | Verified; adapters **Verified-live** |
| 3 Shared intelligence (registry, evidence, context compiler, FTS + pgvector, verification, cross-agent sharing, MCP) | Verified; MCP **Verified-live** with both CLIs |
| 4 Control center (board, assignment, live monitor, projects, memory explorer, reviews) | Verified (Playwright) |
| 5 Advanced (workflow builder, parallel scheduling, collaboration requests, subscriptions, invalidation, Antigravity fallback, Playwright QA) | Verified; Antigravity = assisted only (ADR-011) |
| 6 Hardening (security tests, recovery, observability, docs, e2e) | Partial: security + recovery tests and docs done; no performance testing or OpenTelemetry yet |

## Definition of Done (spec §16)

| # | Capability | Evidence |
|---|---|---|
| 1 | Open the portal | `tests/e2e/portal.spec.ts` "dashboard renders live data" |
| 2 | Register a Git repository | e2e "register a repository" (+ API path validation tests) |
| 3 | View available agents | e2e "agents show verified capabilities" |
| 4–5 | Create a task, assign to Codex/Claude | e2e create/assign; live tests assign `claude` and `codex` agents |
| 6 | Start real agent execution | `tests/live/live-agents.test.ts` (both pass, see below) |
| 7 | Monitor events live | e2e board moves Running → Review via SSE; `api.test.ts` SSE frames |
| 8 | Inspect shared context | e2e Context tab; `e2e-collaboration` asserts snapshot contents |
| 9–10 | Discoveries published; other agent retrieves them | live: Codex publishes via MCP, Claude review consumes it; simulated e2e: via context + search |
| 11 | Review actual file changes | e2e Changes tab and Review Center diff |
| 12 | Inspect validation results | e2e Validation tab; review requirements panel |
| 13 | Approve or reject integration | e2e approve & merge (git asserted); engine tests reject / request changes |
| 14 | Restart without losing state | `engine-scheduling` "reclaims tasks whose worker died and completes them after restart"; durable events |

## Required test scenarios (spec §12)

| # | Scenario | Test |
|---|---|---|
| 1 | Reject cyclic DAGs | engine-scheduling (edits + plans), api (PATCH → 422), workflows (graph) |
| 2 | Prevent duplicate leasing | engine-scheduling "never leases the same task twice under concurrent workers" |
| 3 | Recover after restart | engine-scheduling "reclaims tasks…", "marks running runs abandoned…" |
| 4 | Unauthorized file modifications | engine-execution scope / protected / symlink / read-only |
| 5 | Capability routing | engine-scheduling "routes by capability…"; e2e-collaboration plan routing |
| 6 | Provider process failures | engine-execution "classifies provider process failures and retries" |
| 7 | Execution timeouts | engine-execution "enforces execution timeouts" |
| 8 | Context retrieval scope | knowledge "validates context retrieval scope" |
| 9 | Stale knowledge not authoritative | knowledge "marks knowledge stale…" |
| 10 | Cross-agent knowledge reuse | e2e-collaboration; live Codex → Claude |
| 11 | Failed quality gates | engine-execution "rejects failed quality gates…" |
| 12 | Unauthorized merges | engine-execution + api "prevents unauthorized merges" |
| 13 | Task creation/assignment via portal | Playwright portal.spec |
| 14 | Live status updates | Playwright (SSE board), api SSE test |
| 15 | Cancellation and retry | engine-execution, api, Playwright board |
| E2E | plan → implement → publish → retrieve → review → tests → approve → integrate | `tests/integration/e2e-collaboration.test.ts` (simulated adapters, real everything else) |

## Latest runs (2026-11-07)

- `pnpm typecheck`: clean (root + web).
- `pnpm test`: **13 files, 67 tests passed** (~54 s).
- `pnpm test:e2e` (Playwright, Chromium headless): **8 passed**.
- `pnpm test:live`: **2 passed** (~66 s):
  - Claude Code (`--model haiku`) in bwrap: created the file, passed gates, called
    `knowledge_publish` via the AgentMesh MCP server, and was integrated on approval.
  - Codex (default model) in bwrap: created the file and published via MCP (after ADR-012);
    a Claude review task received Codex's discovery in its context snapshot (consumption
    recorded) and returned a structured verdict.

## Bugs found and fixed during verification

- Adapters ignored an AbortSignal that was already aborted when execution started; a task
  cancelled during setup kept its agent process alive. Fixed via `linkedAbort` (+ unit test).
- React effect returning `scrollIntoView()`'s Promise crashed the task page in Chromium 158.
- Codex rejected MCP calls under approval policy `never` (live); fixed by ADR-012.
