# Agent handoff

Read this first if you are an AI agent continuing work on this repository.

## State (2026-11-07)

All phases are implemented and verified except the gaps in KNOWN_ISSUES.md. Default tests
are green (67 Vitest, 8 Playwright); the opt-in live tests pass against Claude Code 2.1.319
and codex-cli 0.167.0. See IMPLEMENTATION_STATUS.md for the evidence.

## How to work here

- Toolchain: `export PATH=~/.local/opt/node22/bin:$PATH` on the original dev host (Node 22).
- Verify before claiming: `pnpm typecheck && pnpm test`; UI changes: `pnpm test:e2e`;
  adapter changes: `pnpm test:live` (spends tokens; ask the user first).
- Every task status change must go through `transition()` (engine-kernel/tasks.ts).
- Provider-specific code belongs in `adapters/*`. Check CLI flags against the installed
  binary (`--help`, or config-parse errors such as `codex -c key=bogus mcp list`).
- Schema change: edit `packages/database/src/schema.ts` → `pnpm db:generate` → commit the migration.
- Contracts first: request/response and collaboration schemas live in `packages/contracts`.
- Keep business rules out of React components; the portal renders state and calls actions.
- Simulated adapter results never count as live verification.

## Gotchas

- `pkill -f <pattern>` in a shell whose command line contains the pattern kills that shell.
- PGlite is single-backend: the custom wire server serialises transactions (ADR-002). Tests
  that hold a transaction open while waiting on another connection will deadlock.
- Codex needs `default_tools_approval_mode="approve"` for MCP tools under `codex exec` (ADR-012).
- Identical knowledge statements from different agents are deduplicated (by design).
- React effects must not return non-function values (`scrollIntoView` returns a Promise in new Chromium).
