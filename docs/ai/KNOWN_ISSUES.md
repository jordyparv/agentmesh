# Known issues and limitations

| Area | Issue | Impact / workaround |
|---|---|---|
| Antigravity | Unattended execution is not verified; the adapter reports `assisted` and returns `capability_unavailable`. There is no assisted hand-off UI yet (export context, record a manual result). | Visual QA nodes cannot be auto-executed; use Playwright validation commands, or route visual-qa to another agent via capability override. |
| Portal auth | Single-user: the portal uses one server-held admin token; there is no login. | Bind to 127.0.0.1 only (default). Do not expose it on a network. |
| Embeddings | Semantic search uses a deterministic hashing embedder, not a neural model (ADR-007). | Good for paraphrases with shared vocabulary; weaker for pure synonyms. |
| Staleness | Knowledge becomes stale only when AgentMesh integrates changes. Commits made outside AgentMesh don't trigger it. | Use "Revalidate" in the explorer after manual refactors. |
| Approvals | Integration (merge + integration validation) runs inside the approval HTTP request. | Long validation suites make the request slow; move to a job if that matters. |
| Workflow gates | Read-only nodes downstream of an approval node may start once upstream code is validated (AWAITING_APPROVAL), not only after integration (`depSatisfied` semantics). | Put review nodes before the approval node (as the templates do). |
| Live updates | SSE polls the events table (default 500 ms). | Adds latency; no broker needed. |
| Running agents | Agents receive new knowledge only via `context_refresh` (no mid-run push). | By design (safe checkpoints). |
| Worktrees | Failed attempts' worktrees are kept for debugging; there is no time-based GC yet. | Clean `.data/worktrees` manually. |
| Rate limiting | In-memory per API process. | Fine for a single node. |
| Observability | Structured pino logs + audit/event tables; no OpenTelemetry export yet. | — |
| Codex | Inside the sandbox codex logs `failed to refresh available models: request timed out` on stderr. | Harmless; the run proceeds with the configured/default model. |
| Performance | No load or performance testing yet. | — |
| Sandbox | `AGENTMESH_SANDBOX=none` disables isolation entirely. | Only for hosts without bwrap, and never with untrusted repos. |
