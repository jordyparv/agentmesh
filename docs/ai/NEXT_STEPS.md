# Next steps

Ordered by value. Each item should land with tests and doc updates.

1. **Antigravity assisted hand-off**: an endpoint and UI to export a task's context
   snapshot, then submit a manual result (summary, screenshots as artifacts, verdict) that
   goes through the normal quality gates. Separately, investigate `agy -p --output-format stream-json`
   and the ACP server; promote to `automated` only after a live test like `tests/live`.
2. **Integration as a background job**: move approval → merge → integration validation
   onto the worker, with progress events, so the HTTP request returns immediately.
3. **Portal authentication**: login with per-user tokens (the API already supports roles and
   project scopes), so audit actors are real people.
4. **Neural embeddings provider**: implement `Embedder` (e.g. a local model), add a
   re-embed command, and keep the hashing embedder as the fallback.
5. **External change detection**: on worker tick, compare the default branch head with the
   last seen SHA and mark knowledge stale for files changed outside AgentMesh.
6. **Worktree retention GC**: age-based cleanup of failed attempts (policy in project settings).
7. **OpenTelemetry**: spans around lease → run → gates → integration; export via OTLP.
8. **Performance tests**: many concurrent tasks and workers against docker Postgres.
9. **Docker Compose for app services** (api, worker, web) for production-like runs.
