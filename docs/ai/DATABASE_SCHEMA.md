# Database schema

Source of truth: `packages/database/src/schema.ts`. Migrations: `packages/database/migrations`
(generated with `pnpm db:generate`; `0001` starts with `CREATE EXTENSION IF NOT EXISTS vector`).

| Table | Purpose / key columns |
|---|---|
| `api_tokens` | user tokens: `token_hash` (sha256), `role`, `project_ids` (null = all), `revoked_at` |
| `projects` | `repo_path` (unique, realpath), `default_branch`, `instructions`, `policy` (jsonb, `ProjectPolicy`) |
| `agents` | `kind` (adapter), `enabled`, `max_concurrency`, `config` (non-secret), `permissions` (allowWrite, sandbox, secretEnv names), `capability_override`, `discovered_capabilities`, `health`, `integration_mode`, `version` |
| `tasks` | spec fields, `status`, `paused`, `auto_start`, `priority`, `assigned_agent_id`, `assignment_mode`, `allowed_paths`, `modifies_code`, `requires_approval`, `timeout_ms`, `attempt`/`max_attempts`, `idempotency_key` (unique per project), lease (`lease_owner`, `lease_expires_at`, `heartbeat_at`), `next_retry_at`, git (`branch`, `base_sha`, `head_sha`, `worktree_path`), `result`, `error`, `version`, provenance (`parent_task_id`, `origin`, `requested_by_task_id`, `collaboration_depth`, `workflow_run_id`, `workflow_node_id`) |
| `task_dependencies` | (`task_id`, `depends_on_task_id`) PK, `condition` (`success`\|`failure`\|`always`) |
| `runs` | one per (task, attempt) (unique): agent, worker, status, exit code, error class/message, summary, structured output, usage, `context_snapshot_id` |
| `context_snapshots` | immutable rendered prompt + sections, `sha256`, `source_commit_sha`, token estimate/budget |
| `events` | durable event log (bigserial id) for SSE and audit of execution |
| `artifacts` | diff, changed-files, test reports, logs, screenshots (content + sha256) |
| `validations` | quality gate results per run (`stage` run\|integration) |
| `approvals` | human decisions with the decided `head_sha` |
| `audit_log` | every mutation: actor, action, target, redacted detail |
| `knowledge_records` | the `KnowledgeRecord` contract + `scope`, `allowed_agent_ids`, `confidence`, `tags`, `source_*`, `fingerprint`, `superseded_by_id`, `verified_by/at`, `status_reason`, `version`, `embedding vector(256)`, `search tsvector` (generated, GIN) |
| `knowledge_evidence` | kind (run/artifact/validation/file/test/commit/note), reference, excerpt, added_by, commit |
| `knowledge_relations` | (`from_id`, `to_id`, `relation`) PK: duplicates/supports/contradicts/supersedes/relates_to/derived_from |
| `knowledge_consumption` | which record version reached which task/run/agent, via context/search/get/refresh, and which snapshot |
| `knowledge_subscriptions` | per-task filters (types, paths, query) |
| `agent_sessions` | run-scoped agent tokens (hash), request budget, expiry, revocation |
| `workflows` | executable `graph` (jsonb, `WorkflowGraph`), `is_template`, `version` |
| `workflow_runs` | materialisation: workflow version, input, node → task map |

Lifecycle changes always run in a transaction with a row lock (`transition()`); leases use
conditional updates; agent concurrency is counted under `SELECT … FOR UPDATE` on the agent row.
