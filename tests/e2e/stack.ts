/**
 * Full local stack for browser tests: embedded Postgres, migrations, API, worker (bwrap
 * sandbox, MCP bundle), a fixed portal token, and seeded agents. The simulated "sim-*"
 * agents use the controlled test adapter; real CLIs are registered and probed only.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agents, createDb, runMigrations } from "@agentmesh/database";
import { startEmbeddedPostgres } from "@agentmesh/database/dev-server";
import { createEngine, Worker } from "@agentmesh/engine-kernel";
import { createLogger } from "@agentmesh/observability";
import { buildApp, createApiToken } from "@agentmesh/api";
import { engineConfig, loadConfig, makeRegistry, REPO_ROOT } from "@agentmesh/api/config";
import { buildMcpBundle } from "@agentmesh/mcp-server/build";

export const E2E_TOKEN = `am_${"e".repeat(48)}`;
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);

const root = await mkdtemp(path.join(tmpdir(), "agentmesh-e2e-"));
const pg = await startEmbeddedPostgres();
const { db } = createDb(pg.url);
await runMigrations(db);
await createApiToken(db, { name: "e2e-portal", role: "admin", token: E2E_TOKEN });
const cfg = { ...loadConfig({ ...process.env, AGENTMESH_DATA_DIR: path.join(root, "data"), API_PORT: String(API_PORT) }), enableTestAdapter: true, workerId: "e2e-worker" };
const logger = createLogger("e2e", process.env.LOG_LEVEL ?? "warn");
const mcpBundle = await buildMcpBundle(path.join(root, "agentmesh-mcp.mjs"));
const engine = createEngine({ db, registry: makeRegistry(cfg), config: { ...engineConfig(cfg, { mcpBundle }), leaseMs: 5000, heartbeatMs: 300, retryBaseMs: 200 }, logger });
await engine.workflows.seedTemplates(path.join(REPO_ROOT, "workflows"));

const DISCOVERY = { type: "technical_discovery", title: "Greeting helper is not localized", statement: "src/greet.ts hardcodes English; localization will need a message catalog.", affectedPaths: ["src/greet.ts"], evidence: [{ kind: "file", reference: "src/greet.ts:1", excerpt: "Hello" }] };
const seed = [
  { name: "sim-coder", kind: "test", maxConcurrency: 2, config: { capabilities: ["implement", "test"], scripts: { default: [{ message: "writing greet helper" }, { sleepMs: 1500 }, { write: { path: "src/greet.ts", content: "export const greet = (n: string) => `Hello ${n}`;\n" } }, { tool: { name: "knowledge.publish", args: DISCOVERY, required: true } }, { message: "done: added src/greet.ts" }], slow: [{ message: "long running job" }, { sleepMs: 120000 }] } } },
  { name: "sim-reviewer", kind: "test", maxConcurrency: 2, config: { capabilities: ["plan", "review"], scripts: { review: [{ tool: { name: "knowledge.search", args: { query: "greeting" } } }, { output: { verdict: "approve", summary: "Looks good.", findings: [] } }] } } },
  { name: "Claude Code", kind: "claude", maxConcurrency: 1, config: {} },
  { name: "Codex", kind: "codex", maxConcurrency: 1, config: {} },
  { name: "Antigravity", kind: "antigravity", maxConcurrency: 1, config: {} },
];
for (const s of seed) {
  const [a] = await db.insert(agents).values({ ...s, permissions: { allowWrite: true, sandbox: true, secretEnv: [] } }).returning();
  await engine.probeAgent(a!.id);
}

const app = await buildApp({ engine, ssePollMs: 200, rateLimitPerMinute: 100_000 });
await app.listen({ host: "127.0.0.1", port: API_PORT });
engine.config.apiUrl = `http://127.0.0.1:${API_PORT}`;
const worker = new Worker(engine, logger, { maxParallel: 4, pollMs: 200, reconcileMs: 1000, probeMs: 3_600_000 });
await worker.start();
await writeFile(path.join(root, "READY"), "1");
console.log(`e2e stack ready: api=http://127.0.0.1:${API_PORT} root=${root}`);

const stop = async () => {
  await worker.stop();
  await app.close();
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
