import { and, eq, inArray, sql } from "drizzle-orm";
import {
  canTransition,
  conflict,
  DomainError,
  InvalidTransitionError,
  notFound,
  Plan,
  ProjectPolicy,
  type CreateTask,
  type TaskAction,
  type TaskKind,
  type TaskStatus,
} from "@agentmesh/contracts";
import { agents, projects, taskDependencies, tasks, type Db, type DbOrTx, type Tx } from "@agentmesh/database";
import { validateDag } from "./dag.ts";
import { audit, publishEvent } from "./events.ts";
import { checkAgentCanRun } from "./router.ts";

export type TaskRow = typeof tasks.$inferSelect;

export const READ_ONLY_KINDS: readonly TaskKind[] = ["plan", "review"];
export const modifiesCodeFor = (kind: TaskKind) => !READ_ONLY_KINDS.includes(kind);

/**
 * Performs a legal status transition under a row lock. Every lifecycle change in the
 * system goes through here, which guarantees the state machine and the audit/event trail.
 */
export async function transition(
  tx: Tx,
  taskId: string,
  to: TaskStatus,
  opts: { reason: string; actor: string; expectFrom?: TaskStatus[]; expectLeaseOwner?: string; patch?: Partial<typeof tasks.$inferInsert> },
): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
  if (!row) throw notFound("Task", taskId);
  const from = row.status as TaskStatus;
  if (opts.expectFrom && !opts.expectFrom.includes(from)) {
    throw new DomainError("UNEXPECTED_STATUS", `Task ${taskId} is ${from}, expected ${opts.expectFrom.join("|")}`, 409);
  }
  if (opts.expectLeaseOwner !== undefined && row.leaseOwner !== opts.expectLeaseOwner) {
    throw new DomainError("LEASE_LOST", `Task ${taskId} lease is held by ${row.leaseOwner ?? "nobody"}, not ${opts.expectLeaseOwner}`, 409);
  }
  if (!canTransition(from, to)) throw new InvalidTransitionError(taskId, from, to);
  const [updated] = await tx
    .update(tasks)
    .set({ ...opts.patch, status: to, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .returning();
  await publishEvent(tx, { projectId: row.projectId, taskId, type: "task.status", payload: { from, to, reason: opts.reason, actor: opts.actor } });
  return updated!;
}

export class TaskService {
  constructor(private db: Db) {}

  async get(id: string): Promise<TaskRow> {
    const [t] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    if (!t) throw notFound("Task", id);
    return t;
  }

  async dependencies(ids: string[]): Promise<Map<string, string[]>> {
    const m = new Map<string, string[]>(ids.map((i) => [i, []]));
    if (!ids.length) return m;
    const rows = await this.db.select().from(taskDependencies).where(inArray(taskDependencies.taskId, ids));
    for (const r of rows) m.get(r.taskId)?.push(r.dependsOnTaskId);
    return m;
  }

  async create(
    input: CreateTask,
    actor: string,
    opts: {
      idempotencyKey?: string;
      parentTaskId?: string;
      tx?: Tx;
      origin?: TaskRow["origin"];
      requestedByTaskId?: string;
      collaborationDepth?: number;
      workflowRunId?: string;
      workflowNodeId?: string;
      /** Per-dependency conditions (default success). */
      conditions?: Record<string, "success" | "failure" | "always">;
      requiresApproval?: boolean;
    } = {},
  ): Promise<TaskRow> {
    const run = async (tx: Tx) => {
      if (opts.idempotencyKey) {
        const [existing] = await tx.select().from(tasks).where(and(eq(tasks.projectId, input.projectId), eq(tasks.idempotencyKey, opts.idempotencyKey)));
        if (existing) return existing;
      }
      const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId));
      if (!project) throw notFound("Project", input.projectId);
      const policy = ProjectPolicy.parse(project.policy);
      if (input.assignedAgentId) await this.assertAssignable(tx, input.assignedAgentId, input.kind, input.requiredCapabilities);
      await this.assertDepsInProject(tx, input.projectId, input.dependsOn);
      const modifies = modifiesCodeFor(input.kind);
      const [row] = await tx
        .insert(tasks)
        .values({
          projectId: input.projectId,
          parentTaskId: opts.parentTaskId ?? null,
          title: input.title,
          description: input.description,
          acceptanceCriteria: input.acceptanceCriteria,
          kind: input.kind,
          requiredCapabilities: input.requiredCapabilities,
          priority: input.priority,
          assignedAgentId: input.assignedAgentId ?? null,
          assignmentMode: input.assignedAgentId ? "manual" : "auto",
          allowedPaths: input.allowedPaths ?? policy.defaultAllowedPaths,
          modifiesCode: modifies,
          requiresApproval: modifies && (opts.requiresApproval ?? input.requiresApproval ?? policy.requireApproval),
          timeoutMs: input.timeoutMs ?? policy.defaultTimeoutMs,
          maxAttempts: input.maxAttempts ?? policy.maxAttempts,
          autoStart: input.autoStart,
          idempotencyKey: opts.idempotencyKey ?? null,
          origin: opts.origin ?? (opts.parentTaskId ? "plan" : "user"),
          requestedByTaskId: opts.requestedByTaskId ?? null,
          collaborationDepth: opts.collaborationDepth ?? 0,
          workflowRunId: opts.workflowRunId ?? null,
          workflowNodeId: opts.workflowNodeId ?? null,
        })
        .returning();
      if (input.dependsOn.length) {
        await tx.insert(taskDependencies).values(input.dependsOn.map((d) => ({ taskId: row!.id, dependsOnTaskId: d, condition: opts.conditions?.[d] ?? "success" })));
      }
      await publishEvent(tx, { projectId: input.projectId, taskId: row!.id, type: "task.created", payload: { title: input.title, actor, origin: row!.origin, requestedByTaskId: row!.requestedByTaskId } });
      await audit(tx, { actor, action: "task.create", targetType: "task", targetId: row!.id, detail: { title: input.title, dependsOn: input.dependsOn } });
      return row!;
    };
    return opts.tx ? run(opts.tx) : this.db.transaction(run);
  }

  async update(id: string, patch: { title?: string; description?: string; acceptanceCriteria?: string[]; priority?: number; assignedAgentId?: string | null; requiredCapabilities?: string[]; allowedPaths?: string[]; dependsOn?: string[] }, actor: string): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
      if (!t) throw notFound("Task", id);
      const status = t.status as TaskStatus;
      const specEditable = ["PENDING", "READY", "BLOCKED", "FAILED", "CANCELLED", "RETRY_WAIT"].includes(status);
      const specFields = ["title", "description", "acceptanceCriteria", "requiredCapabilities", "allowedPaths", "dependsOn"] as const;
      if (!specEditable && specFields.some((f) => patch[f] !== undefined)) throw conflict(`Task requirements cannot be edited while ${status}`);
      if (patch.assignedAgentId !== undefined) {
        // Reassignment is only safe while no worker holds the task.
        if (!specEditable) throw conflict(`Task cannot be reassigned while ${status}`);
        if (patch.assignedAgentId) await this.assertAssignable(tx, patch.assignedAgentId, t.kind, (patch.requiredCapabilities ?? t.requiredCapabilities) as string[]);
      }
      if (patch.dependsOn) {
        await this.assertDepsInProject(tx, t.projectId, patch.dependsOn);
        await this.assertNoCycle(tx, t.projectId, id, patch.dependsOn);
        await tx.delete(taskDependencies).where(eq(taskDependencies.taskId, id));
        if (patch.dependsOn.length) await tx.insert(taskDependencies).values(patch.dependsOn.map((d) => ({ taskId: id, dependsOnTaskId: d })));
      }
      const { dependsOn: _d, ...rest } = patch;
      const [u] = await tx
        .update(tasks)
        .set({
          ...rest,
          ...(patch.assignedAgentId !== undefined ? { assignmentMode: patch.assignedAgentId ? ("manual" as const) : ("auto" as const) } : {}),
          version: sql`${tasks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, id))
        .returning();
      await publishEvent(tx, { projectId: t.projectId, taskId: id, type: "task.updated", payload: { fields: Object.keys(patch), actor } });
      await audit(tx, { actor, action: "task.update", targetType: "task", targetId: id, detail: patch });
      return u!;
    });
  }

  /** User-facing lifecycle actions. Pause/cancel of a running task is enforced by the worker's heartbeat. */
  async action(id: string, action: TaskAction, actor: string): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
      if (!t) throw notFound("Task", id);
      const status = t.status as TaskStatus;
      let out: TaskRow;
      switch (action) {
        case "start":
          if (status !== "PENDING" && status !== "BLOCKED") throw conflict(`Cannot start a task in ${status}`);
          [out] = (await tx.update(tasks).set({ autoStart: true, paused: false, updatedAt: new Date() }).where(eq(tasks.id, id)).returning()) as [TaskRow];
          await publishEvent(tx, { projectId: t.projectId, taskId: id, type: "task.queued", payload: { actor } });
          break;
        case "pause":
          if (t.paused) throw conflict("Task already paused");
          if (["COMPLETED", "CANCELLED", "FAILED"].includes(status)) throw conflict(`Cannot pause a task in ${status}`);
          [out] = (await tx.update(tasks).set({ paused: true, updatedAt: new Date() }).where(eq(tasks.id, id)).returning()) as [TaskRow];
          await publishEvent(tx, { projectId: t.projectId, taskId: id, type: "task.paused", payload: { actor } });
          break;
        case "resume":
          if (!t.paused) throw conflict("Task is not paused");
          [out] = (await tx.update(tasks).set({ paused: false, updatedAt: new Date() }).where(eq(tasks.id, id)).returning()) as [TaskRow];
          await publishEvent(tx, { projectId: t.projectId, taskId: id, type: "task.resumed", payload: { actor } });
          break;
        case "cancel":
          out = await transition(tx, id, "CANCELLED", { reason: "cancelled by user", actor, patch: { leaseOwner: null, leaseExpiresAt: null } });
          break;
        case "retry":
          if (!["FAILED", "CANCELLED"].includes(status)) throw conflict(`Only failed or cancelled tasks can be retried (task is ${status})`);
          out = await transition(tx, id, "READY", {
            reason: "manual retry",
            actor,
            // A manual retry grants a fresh attempt budget on top of attempts already used.
            patch: { maxAttempts: Math.max(t.maxAttempts, t.attempt + 1), error: null, paused: false, autoStart: true, nextRetryAt: null },
          });
          break;
      }
      await audit(tx, { actor, action: `task.${action}`, targetType: "task", targetId: id });
      return out!;
    });
  }

  /** Converts a planning agent's structured output into a validated child task DAG. */
  async createFromPlan(tx: Tx, parent: TaskRow, planInput: unknown, autoStart: boolean): Promise<TaskRow[]> {
    const plan = Plan.parse(planInput);
    const keys = plan.tasks.map((t) => t.key);
    if (new Set(keys).size !== keys.length) throw new DomainError("INVALID_PLAN", "Duplicate task keys in plan");
    const dag = validateDag(
      keys,
      plan.tasks.flatMap((t) => t.dependsOn.map((d) => ({ from: d, to: t.key }))),
    );
    if (!dag.ok) throw new DomainError("INVALID_PLAN", `Plan is not a valid DAG: ${dag.error}`, 422, dag);
    const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
    const created = new Map<string, TaskRow>();
    for (const key of dag.order) {
      const p = byKey.get(key)!;
      const row = await this.create(
        {
          projectId: parent.projectId,
          title: p.title,
          description: p.description,
          acceptanceCriteria: p.acceptanceCriteria,
          kind: p.kind,
          requiredCapabilities: p.requiredCapabilities,
          priority: parent.priority,
          dependsOn: [parent.id, ...p.dependsOn.map((d) => created.get(d)!.id)],
          allowedPaths: p.allowedPaths,
          autoStart,
        },
        `agent-plan:${parent.id}`,
        { parentTaskId: parent.id, idempotencyKey: `plan:${parent.id}:${parent.attempt}:${key}`, tx },
      );
      created.set(key, row);
    }
    return [...created.values()];
  }

  private async assertAssignable(tx: DbOrTx, agentId: string, kind: string, required: string[]) {
    const [a] = await tx.select().from(agents).where(eq(agents.id, agentId));
    if (!a) throw notFound("Agent", agentId);
    const problem = checkAgentCanRun(a, kind, required);
    if (problem) throw new DomainError("AGENT_NOT_CAPABLE", problem, 422);
  }

  private async assertDepsInProject(tx: DbOrTx, projectId: string, deps: string[]) {
    if (!deps.length) return;
    const rows = await tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(inArray(tasks.id, deps));
    if (rows.length !== new Set(deps).size || rows.some((r) => r.projectId !== projectId)) {
      throw new DomainError("INVALID_DEPENDENCY", "Dependencies must be existing tasks in the same project", 422);
    }
  }

  /** Rejects dependency edits that would introduce a cycle in the project's task graph. */
  private async assertNoCycle(tx: DbOrTx, projectId: string, taskId: string, newDeps: string[]) {
    const all = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId));
    const ids = all.map((r) => r.id);
    const edges = (await tx.select().from(taskDependencies).where(inArray(taskDependencies.taskId, ids)))
      .filter((e) => e.taskId !== taskId)
      .map((e) => ({ from: e.dependsOnTaskId, to: e.taskId }));
    for (const d of newDeps) edges.push({ from: d, to: taskId });
    const v = validateDag(ids, edges);
    if (!v.ok) throw new DomainError("DEPENDENCY_CYCLE", `Dependency change rejected: ${v.error}`, 422, v);
  }
}
