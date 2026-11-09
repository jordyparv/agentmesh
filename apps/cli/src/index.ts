#!/usr/bin/env -S node --import tsx
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Role } from "@agentmesh/contracts";
import { agents, createDb, runMigrations } from "@agentmesh/database";
import { startEmbeddedPostgres } from "@agentmesh/database/dev-server";
import { createEngine } from "@agentmesh/engine-kernel";
import { createLogger } from "@agentmesh/observability";
import { createApiToken } from "@agentmesh/api";
import { engineConfig, loadConfig, makeRegistry, REPO_ROOT } from "@agentmesh/api/config";

const USAGE = `agentmesh <command>

  db serve [--port 54329]          Run the embedded Postgres (PGlite + pgvector) for local dev
  db migrate                       Apply database migrations
  token create --name N --role admin|operator|viewer [--project <id>,...]
  agents seed                      Register Codex, Claude Code and Antigravity agents (probes installed CLIs)
  templates seed                   Load workflow templates from workflows/*/workflow.json
  bootstrap                        migrate + templates + agents + portal token (apps/web/.env.local)
`;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cfg = loadConfig();
const logger = createLogger("cli", process.env.LOG_LEVEL ?? "warn");

async function withEngine<T>(fn: (e: ReturnType<typeof createEngine>) => Promise<T>): Promise<T> {
  const { db, close } = createDb(cfg.databaseUrl, { max: 2 });
  try {
    return await fn(createEngine({ db, registry: makeRegistry(cfg), config: engineConfig({ ...cfg, workerId: "cli" }), logger }));
  } finally {
    await close();
  }
}

async function seedAgents() {
  return withEngine(async (e) => {
    const defs = [
      { name: "Claude Code", kind: "claude", maxConcurrency: 2, config: {} },
      { name: "Codex", kind: "codex", maxConcurrency: 2, config: {} },
      { name: "Antigravity", kind: "antigravity", maxConcurrency: 1, config: {} },
    ];
    const out = [];
    for (const d of defs) {
      let [a] = await e.db.select().from(agents).where(eq(agents.name, d.name));
      if (!a) [a] = await e.db.insert(agents).values({ ...d, permissions: { allowWrite: true, sandbox: true, secretEnv: [] } }).returning();
      const p = await e.probeAgent(a!.id);
      out.push({ name: p.name, kind: p.kind, health: p.health, mode: p.integrationMode, version: p.version, detail: p.probeDetail });
    }
    return out;
  });
}

async function main() {
  const [cmd, sub] = argv;
  if (cmd === "db" && sub === "serve") {
    const dataDir = flag("data-dir") ?? path.join(cfg.dataDir, "pg");
    await mkdir(dataDir, { recursive: true });
    const pg = await startEmbeddedPostgres({ dataDir, port: Number(flag("port") ?? 54329) });
    console.log(`embedded postgres listening: ${pg.url} (data: ${dataDir})`);
    const stop = async () => {
      await pg.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (cmd === "db" && sub === "migrate") {
    const { db, close } = createDb(cfg.databaseUrl, { max: 1 });
    await runMigrations(db);
    await close();
    console.log("migrations applied");
    return;
  }
  if (cmd === "token" && sub === "create") {
    const name = flag("name");
    const role = Role.parse(flag("role") ?? "viewer");
    if (!name) throw new Error("--name is required");
    const projectIds = flag("project")?.split(",").filter(Boolean) ?? null;
    const { db, close } = createDb(cfg.databaseUrl, { max: 1 });
    const t = await createApiToken(db, { name, role, projectIds });
    await close();
    console.log(`token (shown once): ${t.token}`);
    return;
  }
  if (cmd === "agents" && sub === "seed") {
    console.table(await seedAgents());
    return;
  }
  if (cmd === "templates" && sub === "seed") {
    const n = await withEngine((e) => e.workflows.seedTemplates(path.join(REPO_ROOT, "workflows")));
    console.log(`templates added: ${n}`);
    return;
  }
  if (cmd === "bootstrap") {
    const { db, close } = createDb(cfg.databaseUrl, { max: 1 });
    await runMigrations(db);
    const t = await createApiToken(db, { name: `portal-${new Date().toISOString().slice(0, 10)}`, role: "admin" });
    await close();
    await withEngine((e) => e.workflows.seedTemplates(path.join(REPO_ROOT, "workflows")));
    console.table(await seedAgents());
    const envFile = path.join(REPO_ROOT, "apps/web/.env.local");
    await writeFile(envFile, `# Written by \`agentmesh bootstrap\`. Server-side only; never exposed to the browser.\nAGENTMESH_API_URL=${cfg.apiUrl}\nAGENTMESH_API_TOKEN=${t.token}\n`, { mode: 0o600 });
    await chmod(envFile, 0o600);
    console.log(`portal admin token written to ${envFile} (mode 600)`);
    return;
  }
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
