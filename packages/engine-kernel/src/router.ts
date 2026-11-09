import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, tasks, type Db } from "@agentmesh/database";
import { ACTIVE_STATUSES } from "@agentmesh/contracts";
import { publishEvent } from "./events.ts";

type AgentRow = typeof agents.$inferSelect;

/** Capability implied by a task kind when the task does not list explicit requirements. */
const KIND_CAPABILITY: Record<string, string | undefined> = { plan: "plan", implement: "implement", review: "review", test: "test" };

export function effectiveCapabilities(a: AgentRow): string[] {
  return a.capabilityOverride ?? a.discoveredCapabilities;
}

export function requiredFor(kind: string, required: string[]): string[] {
  const implied = KIND_CAPABILITY[kind];
  return [...new Set([...required, ...(implied ? [implied] : [])])];
}

/** Returns a human-readable reason the agent cannot run the task, or null if it can. */
export function checkAgentCanRun(a: AgentRow, kind: string, required: string[]): string | null {
  if (!a.enabled) return `Agent ${a.name} is disabled`;
  if (a.integrationMode !== "automated") return `Agent ${a.name} does not support unattended execution (${a.integrationMode})`;
  const caps = effectiveCapabilities(a);
  const missing = requiredFor(kind, required).filter((c) => !caps.includes(c));
  if (missing.length) return `Agent ${a.name} lacks capabilities: ${missing.join(", ")}`;
  const perms = a.permissions as { allowWrite?: boolean };
  if (!["plan", "review"].includes(kind) && perms.allowWrite === false) return `Agent ${a.name} is not permitted to modify files`;
  return null;
}

/**
 * Picks the best agent for a task: eligible (enabled, automated, healthy, capable,
 * permitted), then least loaded relative to its concurrency limit, then name for determinism.
 * No agent identities are hardcoded.
 */
export function pickAgent(candidates: (AgentRow & { active: number })[], kind: string, required: string[]): AgentRow | null {
  const eligible = candidates.filter((a) => a.health === "healthy" && checkAgentCanRun(a, kind, required) === null);
  eligible.sort((x, y) => x.active / x.maxConcurrency - y.active / y.maxConcurrency || x.name.localeCompare(y.name));
  return eligible[0] ?? null;
}

/** Assigns READY auto-mode tasks without an agent. Manual assignments are never overridden. */
export async function routeUnassigned(db: Db): Promise<number> {
  const pending = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "READY"), isNull(tasks.assignedAgentId), eq(tasks.assignmentMode, "auto"), eq(tasks.paused, false)))
    .orderBy(sql`${tasks.priority} desc`, tasks.createdAt)
    .limit(50);
  if (!pending.length) return 0;
  const loads = await activeLoads(db);
  const all = (await db.select().from(agents)).map((a) => ({ ...a, active: loads.get(a.id) ?? 0 }));
  let n = 0;
  for (const t of pending) {
    const a = pickAgent(all, t.kind, t.requiredCapabilities);
    if (!a) continue;
    const res = await db
      .update(tasks)
      .set({ assignedAgentId: a.id, updatedAt: new Date() })
      .where(and(eq(tasks.id, t.id), isNull(tasks.assignedAgentId)))
      .returning({ id: tasks.id });
    if (res.length) {
      n++;
      await publishEvent(db, { projectId: t.projectId, taskId: t.id, type: "task.assigned", payload: { agentId: a.id, agentName: a.name, mode: "auto" } });
      // Account for queued work so the next pick spreads load.
      const entry = all.find((x) => x.id === a.id);
      if (entry) entry.active += 1;
    }
  }
  return n;
}

export async function activeLoads(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ agentId: tasks.assignedAgentId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(inArray(tasks.status, [...ACTIVE_STATUSES]))
    .groupBy(tasks.assignedAgentId);
  return new Map(rows.filter((r) => r.agentId).map((r) => [r.agentId!, Number(r.n)]));
}
