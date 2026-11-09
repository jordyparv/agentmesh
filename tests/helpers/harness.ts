import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ProjectPolicy, type CreateTask, type TaskStatus } from "@agentmesh/contracts";
import { agents, projects, tasks } from "@agentmesh/database";
import { createEngine, Worker, type Engine, type TaskRow } from "@agentmesh/engine-kernel";
import { AdapterRegistry, selectSandbox, type SandboxKind } from "@agentmesh/execution-runtime";
import { createLogger } from "@agentmesh/observability";
import { testAdapterFactory, type TestAdapterConfig } from "@agentmesh/adapter-test";
import { codexAdapterFactory } from "@agentmesh/adapter-codex";
import { claudeAdapterFactory } from "@agentmesh/adapter-claude";
import { antigravityAdapterFactory } from "@agentmesh/adapter-antigravity";
import { buildApp, createApiToken, type App } from "@agentmesh/api";
import type { Role } from "@agentmesh/contracts";
import { createTestDb, type TestDb } from "./db.ts";

export function makeRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(codexAdapterFactory).register(claudeAdapterFactory).register(antigravityAdapterFactory).register(testAdapterFactory);
}

export function initRepo(dir: string): void {
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("sh", ["-c", `mkdir -p src docs && echo '# demo' > README.md && echo 'export const x = 1;' > src/index.ts`], { cwd: dir });
  g("add", ".");
  g("commit", "-qm", "init");
}

export interface Harness {
  db: TestDb;
  engine: Engine;
  root: string;
  repo: string;
  sandboxKind: SandboxKind;
  createProject(policy?: Partial<ProjectPolicy>): Promise<typeof projects.$inferSelect>;
  createAgent(name: string, cfg: TestAdapterConfig & { maxConcurrency?: number; kind?: string }): Promise<typeof agents.$inferSelect>;
  createTask(input: Partial<CreateTask> & { projectId: string; title: string }): Promise<TaskRow>;
  worker(opts?: { maxParallel?: number; workerId?: string }): Worker;
  waitFor(taskId: string, statuses: TaskStatus[], timeoutMs?: number): Promise<TaskRow>;
  git(...args: string[]): string;
  /** Starts the real Fastify API on an ephemeral port and points agent tools at it. */
  startApi(): Promise<{ app: App; url: string }>;
  token(role: Role, projectIds?: string[] | null): Promise<string>;
  close(): Promise<void>;
}

export async function createHarness(opts: { leaseMs?: number; workerId?: string } = {}): Promise<Harness> {
  const db = await createTestDb();
  const root = await mkdtemp(path.join(tmpdir(), "agentmesh-test-"));
  const repo = path.join(root, "repo");
  initRepo(repo);
  const sandboxKind = (process.env.AGENTMESH_TEST_SANDBOX as SandboxKind | undefined) ?? "bwrap";
  const logger = createLogger("test", process.env.LOG_LEVEL ?? "silent");
  const mkEngine = (workerId: string) =>
    createEngine({
      db: db.db,
      registry: makeRegistry(),
      logger,
      config: { dataDir: path.join(root, "data"), workerId, leaseMs: opts.leaseMs ?? 4000, heartbeatMs: 300, sandbox: selectSandbox(sandboxKind), validationTimeoutMs: 30_000, retryBaseMs: 50 },
    });
  const engine = mkEngine(opts.workerId ?? "worker-1");
  const workers: Worker[] = [];
  const engines: Engine[] = [engine];
  let api: App | null = null;
  const h: Harness = {
    db,
    engine,
    root,
    repo,
    sandboxKind,
    async createProject(policy = {}) {
      const [p] = await db.db
        .insert(projects)
        .values({ name: "demo", repoPath: repo, defaultBranch: "main", instructions: "Keep changes minimal.", policy: ProjectPolicy.parse({ maxAttempts: 1, ...policy }) })
        .returning();
      return p!;
    },
    async createAgent(name, cfg) {
      const { maxConcurrency, kind, ...config } = cfg;
      const [a] = await db.db.insert(agents).values({ name, kind: kind ?? "test", maxConcurrency: maxConcurrency ?? 2, config: config as Record<string, unknown>, permissions: {} }).returning();
      return engine.probeAgent(a!.id);
    },
    createTask(input) {
      return engine.tasks.create(
        { description: "", acceptanceCriteria: [], kind: "implement", requiredCapabilities: [], priority: 50, dependsOn: [], autoStart: true, ...input },
        "test-user",
      );
    },
    worker(o = {}) {
      const e = o.workerId ? mkEngine(o.workerId) : engine;
      if (e !== engine) {
        e.config.apiUrl = engine.config.apiUrl;
        engines.push(e);
      }
      const w = new Worker(e, logger, { maxParallel: o.maxParallel ?? 4, pollMs: 100, reconcileMs: 200, probeMs: 3_600_000 });
      workers.push(w);
      return w;
    },
    async waitFor(taskId, statuses, timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      let last: TaskRow | undefined;
      while (Date.now() < end) {
        [last] = await db.db.select().from(tasks).where(eq(tasks.id, taskId));
        if (last && statuses.includes(last.status as TaskStatus)) return last;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`task ${taskId} did not reach ${statuses.join("|")} (last: ${last?.status}, error: ${JSON.stringify(last?.error)})`);
    },
    git: (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(),
    async startApi() {
      api = await buildApp({ engine, ssePollMs: 100, rateLimitPerMinute: 100_000 });
      const url = await api.listen({ host: "127.0.0.1", port: 0 });
      for (const e of engines) e.config.apiUrl = url;
      return { app: api, url };
    },
    async token(role, projectIds = null) {
      return (await createApiToken(db.db, { name: `${role}-${Math.random().toString(36).slice(2, 8)}`, role, projectIds })).token;
    },
    async close() {
      await Promise.all(workers.map((w) => w.stop()));
      if (api) await api.close();
      await db.teardown();
      await rm(root, { recursive: true, force: true });
    },
  };
  return h;
}

export async function writeRepoFile(repo: string, rel: string, content: string) {
  await writeFile(path.join(repo, rel), content);
}
