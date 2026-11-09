import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { ACTIVE_STATUSES } from "@agentmesh/contracts";
import { agents, runs, taskDependencies, tasks, type Db } from "@agentmesh/database";
import { publishEvent } from "./events.ts";
import { transition, type TaskRow } from "./tasks.ts";

/**
 * A dependency is satisfied when the upstream task is COMPLETED. Read-only dependents
 * (review/plan) may also consume an upstream task that is validated and AWAITING_APPROVAL,
 * which is what lets a reviewer inspect an implementation before a human approves it.
 */
export function depSatisfied(depStatus: string, dependentModifiesCode: boolean): boolean {
  return depStatus === "COMPLETED" || (!dependentModifiesCode && depStatus === "AWAITING_APPROVAL");
}
const DEP_DEAD = ["FAILED", "CANCELLED"];

type DepCondition = "success" | "failure" | "always";
const SETTLED = ["COMPLETED", "FAILED", "CANCELLED"];

/**
 * Evaluates one dependency edge for a waiting task.
 *  - satisfied: the edge no longer holds the task back.
 *  - dead: the edge can never be satisfied (task must block or be skipped).
 */
export function evalDependency(condition: DepCondition, depStatus: string, dependentModifiesCode: boolean): "satisfied" | "waiting" | "dead" {
  if (condition === "always") return SETTLED.includes(depStatus) ? "satisfied" : "waiting";
  if (condition === "failure") return depStatus === "FAILED" ? "satisfied" : depStatus === "COMPLETED" || depStatus === "CANCELLED" ? "dead" : "waiting";
  if (depSatisfied(depStatus, dependentModifiesCode)) return "satisfied";
  return DEP_DEAD.includes(depStatus) ? "dead" : "waiting";
}

/**
 * Promotes PENDING -> READY, PENDING -> BLOCKED, BLOCKED -> PENDING, RETRY_WAIT -> READY. Idempotent.
 * A task whose only dead edges are conditional (failure/always branches not taken) is skipped
 * (CANCELLED with reason) instead of blocking forever.
 */
export async function promote(db: Db): Promise<number> {
  let changed = 0;
  const candidates = await db.select().from(tasks).where(inArray(tasks.status, ["PENDING", "BLOCKED"]));
  if (candidates.length) {
    const deps = await db
      .select({ taskId: taskDependencies.taskId, status: tasks.status, condition: taskDependencies.condition })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(inArray(taskDependencies.taskId, candidates.map((c) => c.id)));
    const byTask = new Map<string, { status: string; condition: DepCondition }[]>();
    for (const d of deps) byTask.set(d.taskId, [...(byTask.get(d.taskId) ?? []), { status: d.status, condition: d.condition }]);
    for (const t of candidates) {
      const ds = (byTask.get(t.id) ?? []).map((d) => ({ ...d, state: evalDependency(d.condition, d.status, t.modifiesCode) }));
      const deadEdges = ds.filter((d) => d.state === "dead");
      const dead = deadEdges.length > 0;
      // Branch not taken: every dead edge is conditional and none of them is a failed success-edge.
      const branchNotTaken = dead && deadEdges.every((d) => d.condition !== "success");
      let to: "READY" | "BLOCKED" | "PENDING" | "CANCELLED" | null = null;
      let reason = "";
      if (t.status === "PENDING" && branchNotTaken) [to, reason] = ["CANCELLED", "skipped: conditional branch not taken"];
      else if (t.status === "PENDING" && dead) [to, reason] = ["BLOCKED", "a dependency failed or was cancelled"];
      else if (t.status === "BLOCKED" && !dead) [to, reason] = ["PENDING", "dependencies recovered"];
      else if (t.status === "PENDING" && t.autoStart && !t.paused && ds.every((d) => d.state === "satisfied")) [to, reason] = ["READY", "dependencies satisfied"];
      if (!to) continue;
      const target = to;
      const ok = await db
        .transaction((tx) => transition(tx, t.id, target, { reason, actor: "scheduler", expectFrom: [t.status as "PENDING" | "BLOCKED"] }))
        .then(() => true)
        .catch(() => false); // lost a race with another scheduler; harmless
      if (ok) changed++;
    }
  }
  const due = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.status, "RETRY_WAIT"), lte(tasks.nextRetryAt, new Date())));
  for (const t of due) {
    const ok = await db
      .transaction((tx) => transition(tx, t.id, "READY", { reason: "retry backoff elapsed", actor: "scheduler", expectFrom: ["RETRY_WAIT"] }))
      .then(() => true)
      .catch(() => false);
    if (ok) changed++;
  }
  return changed;
}

/**
 * Transactionally leases the highest-priority READY task whose assigned agent has spare
 * capacity. The agent row is locked (FOR UPDATE) while counting active work so two
 * workers can never push an agent past its concurrency limit, and the task update is
 * conditional on status = READY so a task can never be leased twice.
 */
export async function leaseNext(db: Db, workerId: string, leaseMs: number, opts: { excludeAgentIds?: string[] } = {}): Promise<TaskRow | null> {
  const candidates = await db
    .select({ id: tasks.id, agentId: tasks.assignedAgentId })
    .from(tasks)
    .innerJoin(agents, eq(agents.id, tasks.assignedAgentId))
    .where(and(eq(tasks.status, "READY"), eq(tasks.paused, false), eq(agents.enabled, true)))
    .orderBy(sql`${tasks.priority} desc`, tasks.createdAt)
    .limit(20);
  for (const c of candidates) {
    if (!c.agentId || opts.excludeAgentIds?.includes(c.agentId)) continue;
    const leased = await db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, c.agentId!)).for("update");
      if (!agent?.enabled) return null;
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.assignedAgentId, agent.id), inArray(tasks.status, [...ACTIVE_STATUSES])))) as [{ n: number }];
      if (Number(n) >= agent.maxConcurrency) return null;
      const now = new Date();
      const [row] = await tx
        .update(tasks)
        .set({
          status: "LEASED",
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          heartbeatAt: now,
          attempt: sql`${tasks.attempt} + 1`,
          version: sql`${tasks.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, c.id), eq(tasks.status, "READY"), eq(tasks.paused, false)))
        .returning();
      if (!row) return null;
      await publishEvent(tx, { projectId: row.projectId, taskId: row.id, type: "task.status", payload: { from: "READY", to: "LEASED", reason: `leased by ${workerId}`, actor: workerId, attempt: row.attempt } });
      return row;
    });
    if (leased) return leased;
  }
  return null;
}

export type HeartbeatOutcome = "ok" | "lost" | "paused";

/** Extends the lease. "lost" means the task was cancelled or reclaimed; the worker must stop. */
export async function heartbeat(db: Db, taskId: string, workerId: string, leaseMs: number): Promise<HeartbeatOutcome> {
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs), heartbeatAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.leaseOwner, workerId), inArray(tasks.status, [...ACTIVE_STATUSES])))
    .returning({ paused: tasks.paused });
  if (!row) return "lost";
  return row.paused ? "paused" : "ok";
}

export function retryDelayMs(attempt: number, baseMs = 5000): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 10 * 60_000);
}

/**
 * Recovery reconciliation, run at worker start-up and periodically: any task whose lease
 * expired (worker crashed or was killed) is moved to RETRY_WAIT (or FAILED when out of
 * attempts) and its run is marked abandoned. Nothing in flight is silently lost.
 */
export async function reconcileExpiredLeases(db: Db, now = new Date()): Promise<number> {
  const expired = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.status, [...ACTIVE_STATUSES]), lt(tasks.leaseExpiresAt, now)));
  let n = 0;
  for (const t of expired) {
    await db
      .transaction(async (tx) => {
        await tx
          .update(runs)
          .set({ status: "abandoned", errorClass: "lease_expired", errorMessage: `lease held by ${t.leaseOwner} expired`, finishedAt: now })
          .where(and(eq(runs.taskId, t.id), eq(runs.status, "running")));
        const exhausted = t.attempt >= t.maxAttempts;
        await transition(tx, t.id, exhausted ? "FAILED" : "RETRY_WAIT", {
          reason: `lease expired (owner ${t.leaseOwner}); recovered`,
          actor: "recovery",
          expectFrom: [t.status as "LEASED"],
          patch: {
            leaseOwner: null,
            leaseExpiresAt: null,
            nextRetryAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(t.attempt, 1000)),
            error: { class: "lease_expired", message: "worker lost before completion" },
          },
        });
        n++;
      })
      .catch(() => undefined);
  }
  return n;
}
