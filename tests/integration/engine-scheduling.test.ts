import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { projects, runs, tasks } from "@agentmesh/database";
import { leaseNext, promote, reconcileExpiredLeases, routeUnassigned } from "@agentmesh/engine-kernel";
import { createHarness, type Harness } from "../helpers/harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("DAG validation (scenario 1)", () => {
  it("rejects dependency edits that would create a cycle", async () => {
    const p = await h.createProject();
    const a = await h.createTask({ projectId: p.id, title: "A" });
    const b = await h.createTask({ projectId: p.id, title: "B", dependsOn: [a.id] });
    const c = await h.createTask({ projectId: p.id, title: "C", dependsOn: [b.id] });
    await expect(h.engine.tasks.update(a.id, { dependsOn: [c.id] }, "u")).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
    await expect(h.engine.tasks.update(a.id, { dependsOn: [a.id] }, "u")).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
  });

  it("rejects cyclic plans from planning agents", async () => {
    const p = await h.createProject();
    const parent = await h.createTask({ projectId: p.id, title: "plan", kind: "plan" });
    const plan = { tasks: [{ key: "x", title: "X", dependsOn: ["y"] }, { key: "y", title: "Y", dependsOn: ["x"] }] };
    await expect(h.db.db.transaction((tx) => h.engine.tasks.createFromPlan(tx, parent, plan, false))).rejects.toMatchObject({ code: "INVALID_PLAN" });
  });

  it("rejects dependencies on tasks in other projects", async () => {
    const p1 = await h.createProject();
    const [p2] = await h.db.db.insert(projects).values({ name: "other", repoPath: "/other/repo", defaultBranch: "main", policy: {} }).returning();
    const foreign = await h.createTask({ projectId: p2!.id, title: "foreign" });
    await expect(h.createTask({ projectId: p1.id, title: "x", dependsOn: [foreign.id] })).rejects.toMatchObject({ code: "INVALID_DEPENDENCY" });
    await expect(h.createTask({ projectId: p1.id, title: "x", dependsOn: ["00000000-0000-4000-8000-000000000000"] })).rejects.toMatchObject({ code: "INVALID_DEPENDENCY" });
  });
});

describe("leasing (scenario 2)", () => {
  it("never leases the same task twice under concurrent workers", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("coder", { maxConcurrency: 10 });
    const t = await h.createTask({ projectId: p.id, title: "only one", assignedAgentId: agent.id });
    await promote(h.db.db);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => leaseNext(h.db.db, `w${i}`, 10_000)));
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(t.id);
    const [row] = await h.db.db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(row!.status).toBe("LEASED");
    expect(row!.attempt).toBe(1);
  });

  it("enforces per-agent concurrency limits", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("solo", { maxConcurrency: 1 });
    for (let i = 0; i < 4; i++) await h.createTask({ projectId: p.id, title: `t${i}`, assignedAgentId: agent.id });
    await promote(h.db.db);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => leaseNext(h.db.db, `w${i}`, 10_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("capability routing (scenario 5)", () => {
  it("routes by capability and refuses incapable manual assignment", async () => {
    const p = await h.createProject();
    const planner = await h.createAgent("planner", { capabilities: ["plan", "review"] });
    const coder = await h.createAgent("coder", { capabilities: ["implement", "test"] });
    await h.createAgent("broken", { capabilities: ["implement"], unavailable: true });
    const impl = await h.createTask({ projectId: p.id, title: "impl", kind: "implement" });
    const plan = await h.createTask({ projectId: p.id, title: "plan", kind: "plan" });
    const browser = await h.createTask({ projectId: p.id, title: "visual", kind: "generic", requiredCapabilities: ["browser"] });
    await promote(h.db.db);
    await routeUnassigned(h.db.db);
    const get = async (id: string) => (await h.db.db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
    expect((await get(impl.id)).assignedAgentId).toBe(coder.id);
    expect((await get(plan.id)).assignedAgentId).toBe(planner.id);
    expect((await get(browser.id)).assignedAgentId).toBeNull(); // nobody can do it; stays unassigned
    await expect(h.createTask({ projectId: p.id, title: "x", kind: "implement", assignedAgentId: planner.id })).rejects.toMatchObject({ code: "AGENT_NOT_CAPABLE" });
  });
});

describe("recovery (scenario 3)", () => {
  it("reclaims tasks whose worker died and completes them after restart", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("coder", { scripts: { default: [{ write: { path: "src/a.ts", content: "export const a = 1;\n" } }] } });
    const t = await h.createTask({ projectId: p.id, title: "survive a crash", assignedAgentId: agent.id, maxAttempts: 2, requiresApproval: true });
    await promote(h.db.db);
    // Worker "dead-1" leases and then crashes (never heartbeats).
    const leased = await leaseNext(h.db.db, "dead-1", 1);
    expect(leased?.id).toBe(t.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(await reconcileExpiredLeases(h.db.db)).toBe(1);
    const [afterRecover] = await h.db.db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(afterRecover!.status).toBe("RETRY_WAIT");
    // A fresh worker (new process after restart) picks it up.
    const w = h.worker({ workerId: "worker-2" });
    await w.start();
    const done = await h.waitFor(t.id, ["AWAITING_APPROVAL", "FAILED"]);
    expect(done.status).toBe("AWAITING_APPROVAL");
    expect(done.attempt).toBe(2);
  });

  it("marks running runs abandoned when their lease expires", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("coder", {});
    const t = await h.createTask({ projectId: p.id, title: "x", assignedAgentId: agent.id, maxAttempts: 1 });
    await promote(h.db.db);
    await leaseNext(h.db.db, "dead", 1);
    await h.db.db.insert(runs).values({ taskId: t.id, agentId: agent.id, attempt: 1, workerId: "dead", status: "running" });
    await new Promise((r) => setTimeout(r, 20));
    await reconcileExpiredLeases(h.db.db);
    const [row] = await h.db.db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(row!.status).toBe("FAILED"); // out of attempts
    const [run] = await h.db.db.select().from(runs).where(eq(runs.taskId, t.id));
    expect(run!.status).toBe("abandoned");
  });
});
