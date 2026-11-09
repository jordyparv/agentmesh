# API contracts

Base: `/api/v1`. JSON. Auth: `Authorization: Bearer am_<48 hex>` (user tokens). Request
validation uses the shared Zod schemas in `packages/contracts`; the OpenAPI 3 document is
generated from them at `GET /api/v1/openapi.json`. Errors: `{ "error": { "code", "message", "details?" } }`
with 400 (validation), 401, 403, 404, 409 (conflict / invalid transition), 415, 422 (domain rule), 429, 502, 503.

All mutating routes require a role (shown) and write to `audit_log`. Project-scoped tokens
get 403 outside their projects.

| Group | Routes |
|---|---|
| health | `GET /health` (no auth), `GET /openapi.json` (no auth) |
| projects | `GET /projects` · `POST /projects` (admin; repo path validation) · `GET /projects/:id` · `PATCH /projects/:id` (operator; policy → admin) · `GET /projects/:id/repository` · `GET /projects/:id/history` |
| agents | `GET /agents` · `POST /agents` (admin; probes) · `GET /agents/:id` · `PATCH /agents/:id` (admin) · `POST /agents/:id/probe` (operator) · `GET /agents/:id/runs` |
| integrations | `GET /integrations` (installed adapter kinds) |
| tasks | `GET /tasks?projectId&status&agentId` · `POST /tasks` (operator; `Idempotency-Key` header) · `GET /tasks/:id` · `PATCH /tasks/:id` (operator; edit/reassign only while not in flight; cycle check) · `POST /tasks/:id/actions {action: start\|pause\|resume\|cancel\|retry}` (operator) · `GET /tasks/:id/runs` · `GET /tasks/:id/events?after&limit` · `GET /tasks/:id/validations` · `GET /tasks/:id/artifacts` · `GET /tasks/:id/context` · `GET /tasks/:id/knowledge` |
| runs | `GET /runs/:id` |
| context | `GET /context/:snapshotId` (rendered snapshot + knowledge delivered) |
| artifacts | `GET /artifacts/:id` |
| reviews | `GET /reviews?projectId` (queue) · `GET /reviews/:taskId` (diff, gates, reviewer findings, merge preview, requirements, history) |
| approvals | `GET /approvals?taskId` · `POST /approvals/:taskId {decision: approved\|rejected\|changes_requested, comment}` (operator; agents are refused) |
| knowledge | `GET /knowledge?projectId&q&types&statuses&paths&limit` (list or hybrid search) · `POST /knowledge` (operator) · `GET /knowledge/conflicts?projectId` · `GET /knowledge/:id` (record, evidence, relations, consumers) · `POST /knowledge/:id/actions` (operator; verify/accept/dispute/reject/revalidate/add_evidence) |
| workflows | `GET /workflows?projectId` · `POST /workflows/validate` · `POST /workflows` (operator; templates/global → admin) · `GET/PUT/DELETE /workflows/:id` · `POST /workflows/:id/runs {projectId, input:{goal,...}, autoStart}` · `GET /workflows/:id/runs` |
| events | `GET /events?projectId&taskId&after&limit` · `GET /events/stream?projectId&taskId&after&format=named\|message` (SSE, `Last-Event-ID`) · `GET /events/task-status?projectId` |
| stats | `GET /stats?projectId&days` (dashboard aggregates) |

## Agent collaboration (separate auth realm)

`Authorization: Bearer amr_<48 hex>` (run-scoped, valid only while the run is `running`).

- `GET /agent-tools` describes the session and lists operations.
- `POST /agent-tools/:op` takes a body that matches `OpInputs[op]` in `packages/contracts/src/knowledge.ts`.

| op | effect |
|---|---|
| `knowledge.publish` | provisional record (dedupe exact/near, evidence, scope, relations) |
| `knowledge.search` | hybrid search scoped to the run's project/agent/task; records consumption |
| `knowledge.get` | record + evidence + relations + consumers |
| `knowledge.subscribe` | subscription for this task (types/paths/query) |
| `knowledge.verify` | confirm/dispute another agent's record with evidence |
| `context.refresh` | records changed since the snapshot + subscription notifications |
| `agent.requestHelp` | help task (origin `help_request`, depth+1 ≤ 2, ≤ 5 per run) |
| `agent.requestReview` | review task depending on this task |
| `task.propose` | backlog task, not auto-started |
| `task.getStatus` | status of this or a same-project task |
| `task.reportFinding` | `known_issue` record with severity tag |

MCP exposes the same operations with `_` instead of `.` in the tool name.

## Adapter contract

`packages/contracts/src/adapter.ts`: `probe() → AgentCapabilities`,
`execute(ExecutionRequest, AbortSignal) → ExecutionResult`, `cancel(runId)`. Adapters must
wrap their process with `request.wrapCommand` (sandbox), honour already-aborted signals
(`linkedAbort`), classify errors (`ErrorClass`), and register `request.mcp` when present.
