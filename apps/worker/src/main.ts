import { existsSync } from "node:fs";
import { createDb } from "@agentmesh/database";
import { createEngine, Worker } from "@agentmesh/engine-kernel";
import { createLogger } from "@agentmesh/observability";
import { buildMcpBundle, MCP_BUNDLE } from "@agentmesh/mcp-server/build";
import { engineConfig, loadConfig, makeRegistry } from "@agentmesh/api/config";

/**
 * Independently executable worker process. Any number can run against the same database;
 * leasing is transactional, so a task is executed by at most one worker at a time, and a
 * restarted worker recovers tasks whose leases expired.
 */
const cfg = loadConfig();
const logger = createLogger("worker");
const mcpBundle = existsSync(MCP_BUNDLE) ? MCP_BUNDLE : await buildMcpBundle();
const { db, close } = createDb(cfg.databaseUrl);
const engine = createEngine({ db, registry: makeRegistry(cfg), config: engineConfig(cfg, { mcpBundle }), logger });
const worker = new Worker(engine, logger, {
  maxParallel: Number(process.env.AGENTMESH_WORKER_PARALLEL ?? 4),
  pollMs: 1000,
  reconcileMs: 15_000,
  probeMs: 10 * 60_000,
});
await worker.start();
logger.info({ workerId: cfg.workerId, sandbox: cfg.sandbox, apiUrl: cfg.apiUrl, mcpBundle }, "worker started");

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  logger.info("worker stopping: aborting in-flight runs and releasing leases");
  await worker.stop();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
