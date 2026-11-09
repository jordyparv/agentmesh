import { createDb } from "@agentmesh/database";
import { createEngine } from "@agentmesh/engine-kernel";
import { createLogger } from "@agentmesh/observability";
import { buildApp } from "./app.ts";
import { engineConfig, loadConfig, makeRegistry } from "./config.ts";

const cfg = loadConfig();
const logger = createLogger("api");
const { db, close } = createDb(cfg.databaseUrl);
const engine = createEngine({ db, registry: makeRegistry(cfg), config: engineConfig({ ...cfg, workerId: `api-${process.pid}` }), logger });
const app = await buildApp({ engine, allowedRepoRoots: cfg.allowedRepoRoots, logger: { level: process.env.LOG_LEVEL ?? "info" } });
if (!cfg.allowedRepoRoots.length) logger.warn("AGENTMESH_ALLOWED_REPO_ROOTS is not set: any local git repository can be registered by an admin");
await app.listen({ host: cfg.apiHost, port: cfg.apiPort });

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
