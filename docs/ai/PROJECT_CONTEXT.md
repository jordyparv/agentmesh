# Project context

**AgentMesh** is a local-first platform that lets multiple AI coding agents (Claude Code,
OpenAI Codex, Google Antigravity; extensible via adapters) work on the same Git repository
through a deterministic engine and a shared, verified knowledge fabric, managed from a web
control center.

Core idea: collaborative intelligence. One agent's discoveries (with provenance and
evidence) become retrievable, rankable and verifiable context for other agents, and are
never silently treated as authoritative instructions.

## Constraints

- TypeScript strict, Node 22+, pnpm workspaces, Fastify, Next.js App Router, Drizzle,
  PostgreSQL (+pgvector, FTS), SSE, Vitest, Playwright, Docker Compose.
- No Kubernetes, Kafka, Redis or microservices.
- Never fake execution status; a CLI exit code is not completion.
- Never invent unsupported CLI flags. Flags in adapters were checked against
  `claude --help` / `codex exec --help` / config errors of the installed versions.
- Simulated (test adapter) results are kept apart from verified live results.

## Users and roles

Local developer(s) operating a single host. API tokens with roles `admin` (projects, agents,
policy), `operator` (tasks, approvals, knowledge decisions), and `viewer`, optionally scoped
to projects. Agents get run-scoped tokens that work only for collaboration operations.

## Canonical docs

- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Decisions: [DECISIONS.md](DECISIONS.md)
- Status and evidence: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)
- API: [API_CONTRACTS.md](API_CONTRACTS.md) (live OpenAPI at `/api/v1/openapi.json`)
- Database: [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)
- Known issues: [KNOWN_ISSUES.md](KNOWN_ISSUES.md)
- Next steps: [NEXT_STEPS.md](NEXT_STEPS.md)
- Handoff notes for the next agent: [AGENT_HANDOFF.md](AGENT_HANDOFF.md)
