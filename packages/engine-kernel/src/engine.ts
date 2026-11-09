import { eq } from "drizzle-orm";
import { agents, type Db } from "@agentmesh/database";
import type { AdapterRegistry } from "@agentmesh/execution-runtime";
import type { Logger } from "@agentmesh/observability";
import { WorkspaceManager } from "@agentmesh/workspace-manager";
import path from "node:path";
import { KnowledgeService, type Embedder } from "@agentmesh/shared-memory";
import { ApprovalService } from "./approvals.ts";
import { CollaborationService } from "./collaboration.ts";
import { WorkflowService } from "./workflows.ts";
import { TaskExecutor, type EngineConfig } from "./executor.ts";
import { publishEvent } from "./events.ts";
import { routeUnassigned } from "./router.ts";
import { leaseNext, promote, reconcileExpiredLeases } from "./scheduler.ts";
import { TaskService, type TaskRow } from "./tasks.ts";

export interface Engine {
  db: Db;
  registry: AdapterRegistry;
  config: EngineConfig;
  tasks: TaskService;
  approvals: ApprovalService;
  workspaces: WorkspaceManager;
  executor: TaskExecutor;
  knowledge: KnowledgeService;
  collaboration: CollaborationService;
  workflows: WorkflowService;
  probeAgent(agentId: string): Promise<typeof agents.$inferSelect>;
}

export function createEngine(opts: { db: Db; registry: AdapterRegistry; config: EngineConfig; logger: Logger; embedder?: Embedder }): Engine {
  const workspaces = new WorkspaceManager(path.join(opts.config.dataDir, "worktrees"));
  const tasks = new TaskService(opts.db);
  const knowledge = new KnowledgeService(opts.db, opts.embedder);
  const collaboration = new CollaborationService(opts.db, knowledge, tasks);
  const workflows = new WorkflowService(opts.db, tasks);
  const approvals = new ApprovalService({
    db: opts.db,
    workspaces,
    sandbox: opts.config.sandbox,
    validationTimeoutMs: opts.config.validationTimeoutMs,
    onIntegrated: async (e) => {
      const stale = await knowledge.markStaleForChanges(e.projectId, e.changedPaths, { taskId: e.taskId, mergeSha: e.mergeSha });
      if (stale.length) opts.logger.info({ stale, taskId: e.taskId }, "knowledge marked stale after integration");
    },
  });
  const executor = new TaskExecutor({ db: opts.db, registry: opts.registry, workspaces, tasksService: tasks, approvals, config: opts.config, logger: opts.logger, knowledge, collaboration });
  return {
    db: opts.db,
    registry: opts.registry,
    config: opts.config,
    tasks,
    approvals,
    workspaces,
    executor,
    knowledge,
    collaboration,
    workflows,
    async probeAgent(agentId) {
      const [a] = await opts.db.select().from(agents).where(eq(agents.id, agentId));
      if (!a) throw new Error(`agent ${agentId} not found`);
      let caps;
      try {
        caps = await opts.registry.create(a).probe();
      } catch (e) {
        caps = { available: false, version: null, capabilities: [], integrationMode: "unavailable" as const, detail: e instanceof Error ? e.message : String(e) };
      }
      const [u] = await opts.db
        .update(agents)
        .set({
          health: caps.available ? "healthy" : "unavailable",
          discoveredCapabilities: caps.capabilities,
          integrationMode: caps.integrationMode,
          version: caps.version,
          probeDetail: caps.detail,
          lastProbeAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId))
        .returning();
      await publishEvent(opts.db, { type: "agent.probed", payload: { agentId, health: u!.health, integrationMode: caps.integrationMode, version: caps.version } });
      return u!;
    },
  };
}

/**
 * Worker loop: recovery on start, then repeatedly promote -> route -> lease -> execute,
 * bounded by maxParallel. stop() aborts in-flight runs and releases their leases.
 */
export class Worker {
  private running = new Map<string, Promise<void>>();
  private shutdown = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private lastReconcile = 0;
  private lastProbe = 0;
  private ticking = false;

  constructor(
    private engine: Engine,
    private logger: Logger,
    private opts: { maxParallel: number; pollMs: number; reconcileMs: number; probeMs: number },
  ) {}

  async start(): Promise<void> {
    const recovered = await reconcileExpiredLeases(this.engine.db);
    if (recovered) this.logger.warn({ recovered }, "recovered tasks with expired leases");
    await this.probeAll();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    await this.tick();
  }

  async probeAll(): Promise<void> {
    this.lastProbe = Date.now();
    for (const a of await this.engine.db.select({ id: agents.id }).from(agents)) {
      await this.engine.probeAgent(a.id).catch((e) => this.logger.error({ err: e, agentId: a.id }, "probe failed"));
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.shutdown.signal.aborted) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (now - this.lastReconcile > this.opts.reconcileMs) {
        this.lastReconcile = now;
        await reconcileExpiredLeases(this.engine.db);
      }
      if (now - this.lastProbe > this.opts.probeMs) await this.probeAll();
      await promote(this.engine.db);
      await routeUnassigned(this.engine.db);
      while (this.running.size < this.opts.maxParallel && !this.shutdown.signal.aborted) {
        const task = await leaseNext(this.engine.db, this.engine.config.workerId, this.engine.config.leaseMs);
        if (!task) break;
        this.launch(task);
      }
    } catch (e) {
      this.logger.error({ err: e }, "worker tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private launch(task: TaskRow) {
    this.logger.info({ taskId: task.id, attempt: task.attempt }, "executing task");
    const p = this.engine.executor
      .run(task, this.shutdown.signal)
      .catch((e) => this.logger.error({ err: e, taskId: task.id }, "executor crashed"))
      .finally(() => {
        this.running.delete(task.id);
        // Completion may unblock dependents; schedule promptly.
        setImmediate(() => void this.tick());
      });
    this.running.set(task.id, p);
  }

  get activeCount(): number {
    return this.running.size;
  }

  /** Resolves when no task is executing (test helper). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    await this.drain();
  }
}
