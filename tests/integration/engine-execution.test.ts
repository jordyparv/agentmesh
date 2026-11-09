import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { artifacts, events, runs, tasks, validations } from "@agentmesh/database";
import { createHarness, type Harness } from "../helpers/harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const runsFor = async (taskId: string) => h.db.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(runs.attempt);
const gatesFor = async (taskId: string) => h.db.db.select().from(validations).where(eq(validations.taskId, taskId));

describe("execution, validation and approval", () => {
  it("validates, awaits approval, then integrates into the default branch", async () => {
    const p = await h.createProject({ validationCommands: ["test -f src/feature.ts", "grep -q feature src/feature.ts"] });
    const agent = await h.createAgent("coder", { scripts: { default: [{ message: "implementing" }, { write: { path: "src/feature.ts", content: "export const feature = true;\n" } }] } });
    const t = await h.createTask({ projectId: p.id, title: "add feature", assignedAgentId: agent.id, allowedPaths: ["src/**"] });
    const w = h.worker();
    await w.start();
    const awaiting = await h.waitFor(t.id, ["AWAITING_APPROVAL", "FAILED"]);
    expect(awaiting.status, JSON.stringify(awaiting.error)).toBe("AWAITING_APPROVAL");
    expect(awaiting.headSha).toMatch(/^[0-9a-f]{40}$/);
    const gates = await gatesFor(t.id);
    expect(gates.map((g) => [g.gate, g.passed])).toEqual(
      expect.arrayContaining([["agent_result", true], ["file_scope", true], ["command:test -f src/feature.ts", true], ["command:grep -q feature src/feature.ts", true]]),
    );
    const diff = await h.db.db.select().from(artifacts).where(and(eq(artifacts.taskId, t.id), eq(artifacts.kind, "diff")));
    expect(diff[0]!.content).toContain("+export const feature = true;");
    // Default branch untouched before approval.
    expect(h.git("ls-tree", "-r", "--name-only", "main")).not.toContain("src/feature.ts");

    const { task, integration } = await h.engine.approvals.decide(t.id, "approved", "lgtm", "user:alice");
    expect(integration?.ok).toBe(true);
    expect(task.status).toBe("COMPLETED");
    expect(h.git("ls-tree", "-r", "--name-only", "main")).toContain("src/feature.ts");
    const evTypes = (await h.db.db.select().from(events).where(eq(events.taskId, t.id))).map((e) => e.type);
    expect(evTypes).toEqual(expect.arrayContaining(["task.created", "task.status", "agent.message", "validation.gate", "integration.completed"]));
  });

  it("rejects modifications outside the task's file scope (scenario 4)", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("coder", { scripts: { default: [{ write: { path: "src/ok.ts", content: "1" } }, { write: { path: "docs/sneaky.md", content: "x" } }] } });
    const t = await h.createTask({ projectId: p.id, title: "scoped", assignedAgentId: agent.id, allowedPaths: ["src/**"] });
    await h.worker().start();
    const done = await h.waitFor(t.id, ["FAILED", "AWAITING_APPROVAL", "COMPLETED"]);
    expect(done.status).toBe("FAILED");
    const scope = (await gatesFor(t.id)).find((g) => g.gate === "file_scope")!;
    expect(scope.passed).toBe(false);
    expect(JSON.stringify(scope.detail)).toContain("docs/sneaky.md");
    expect(h.git("ls-tree", "-r", "--name-only", "main")).not.toContain("docs/sneaky.md");
  });

  it("rejects protected paths and symlink escapes (scenario 4)", async () => {
    const p = await h.createProject({ protectedPaths: ["src/secret/**"] });
    const agent = await h.createAgent("coder", {
      scripts: { default: [{ write: { path: "src/secret/key.ts", content: "k" } }, { symlink: { path: "src/escape", target: "/etc/passwd" } }] },
    });
    const t = await h.createTask({ projectId: p.id, title: "evil", assignedAgentId: agent.id });
    await h.worker().start();
    await h.waitFor(t.id, ["FAILED"]);
    const detail = JSON.stringify((await gatesFor(t.id)).find((g) => g.gate === "file_scope")!.detail);
    expect(detail).toContain("protected_path");
    expect(detail).toContain("symlink_escape");
  });

  it("prevents read-only tasks from writing", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("reviewer", { capabilities: ["review"], scripts: { review: [{ write: { path: "src/x.ts", content: "x" } }, { output: { verdict: "approve", summary: "", findings: [] } }] } });
    const t = await h.createTask({ projectId: p.id, title: "review", kind: "review", assignedAgentId: agent.id });
    await h.worker().start();
    const done = await h.waitFor(t.id, ["FAILED", "COMPLETED"]);
    expect(done.status).toBe("FAILED");
    if (h.sandboxKind === "bwrap") {
      // The OS sandbox mounts the worktree read-only, so the write fails at the process level.
      expect((await runsFor(t.id))[0]!.status).toBe("failed");
    }
  });

  it("classifies provider process failures and retries with backoff (scenario 6)", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("flaky", { scripts: { default: [{ exit: 3, stderr: "provider exploded" }] } });
    const t = await h.createTask({ projectId: p.id, title: "fails", assignedAgentId: agent.id, maxAttempts: 2 });
    await h.worker().start();
    const done = await h.waitFor(t.id, ["FAILED"]);
    const rs = await runsFor(t.id);
    expect(rs.map((r) => [r.attempt, r.status, r.errorClass])).toEqual([
      [1, "failed", "nonzero_exit"],
      [2, "failed", "nonzero_exit"],
    ]);
    expect(rs[0]!.errorMessage).toContain("provider exploded");
    expect(done.attempt).toBe(2);
  });

  it("enforces execution timeouts (scenario 7)", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("slow", { scripts: { default: [{ sleepMs: 30_000 }] } });
    const t = await h.createTask({ projectId: p.id, title: "slow", assignedAgentId: agent.id, timeoutMs: 1500 });
    const started = Date.now();
    await h.worker().start();
    await h.waitFor(t.id, ["FAILED"]);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await runsFor(t.id))[0]).toMatchObject({ status: "timed_out", errorClass: "timeout" });
  });

  it("rejects failed quality gates and never completes the task (scenario 11)", async () => {
    const p = await h.createProject({ validationCommands: ["test -f DOES_NOT_EXIST"] });
    const agent = await h.createAgent("coder", { scripts: { default: [{ write: { path: "src/y.ts", content: "y" } }] } });
    const t = await h.createTask({ projectId: p.id, title: "gated", assignedAgentId: agent.id, maxAttempts: 2 });
    await h.worker().start();
    const done = await h.waitFor(t.id, ["FAILED", "COMPLETED", "AWAITING_APPROVAL"]);
    expect(done.status).toBe("FAILED");
    expect((done.error as { class: string }).class).toBe("quality_gate");
    expect((await runsFor(t.id)).length).toBe(2); // retried once with gate feedback
  });

  it("supports cancellation of a running task and manual retry (scenario 15)", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("coder", { scripts: { default: [{ sleepMs: 1500 }, { write: { path: "src/z.ts", content: "z" } }] } });
    const t = await h.createTask({ projectId: p.id, title: "cancel me", assignedAgentId: agent.id });
    await h.worker().start();
    await h.waitFor(t.id, ["RUNNING"]);
    await h.engine.tasks.action(t.id, "cancel", "user:bob");
    await h.waitFor(t.id, ["CANCELLED"]);
    // The heartbeat notices the cancellation and kills the agent process.
    await expect.poll(async () => (await runsFor(t.id))[0]?.status, { timeout: 5000 }).toBe("cancelled");
    await expect(h.engine.tasks.action(t.id, "cancel", "user:bob")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await h.engine.tasks.action(t.id, "retry", "user:bob");
    const done = await h.waitFor(t.id, ["AWAITING_APPROVAL", "FAILED"]);
    expect(done.status).toBe("AWAITING_APPROVAL");
    expect((await runsFor(t.id)).map((r) => r.status)).toEqual(["cancelled", "succeeded"]);
  });

  it("pauses a running task and resumes it without consuming an attempt", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("coder", { scripts: { default: [{ sleepMs: 1500 }, { write: { path: "src/p.ts", content: "p" } }] } });
    const t = await h.createTask({ projectId: p.id, title: "pause me", assignedAgentId: agent.id, maxAttempts: 1 });
    await h.worker().start();
    await h.waitFor(t.id, ["RUNNING"]);
    await h.engine.tasks.action(t.id, "pause", "user");
    const paused = await h.waitFor(t.id, ["READY"]);
    expect(paused.paused).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect((await h.db.db.select().from(tasks).where(eq(tasks.id, t.id)))[0]!.status).toBe("READY"); // not re-leased while paused
    await h.engine.tasks.action(t.id, "resume", "user");
    const done = await h.waitFor(t.id, ["AWAITING_APPROVAL", "FAILED"]);
    expect(done.status).toBe("AWAITING_APPROVAL");
  });

  it("prevents unauthorized and premature merges (scenario 12)", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("coder", { scripts: { default: [{ write: { path: "src/m.ts", content: "m" } }] } });
    const t = await h.createTask({ projectId: p.id, title: "merge", assignedAgentId: agent.id });
    await expect(h.engine.approvals.decide(t.id, "approved", "", "user:x")).rejects.toMatchObject({ code: "CONFLICT" }); // not awaiting approval
    await h.worker().start();
    await h.waitFor(t.id, ["AWAITING_APPROVAL"]);
    await expect(h.engine.approvals.decide(t.id, "approved", "", "agent:codex")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = h.git("rev-parse", "main");
    const { task } = await h.engine.approvals.decide(t.id, "rejected", "no", "user:x");
    expect(task.status).toBe("FAILED");
    expect(h.git("rev-parse", "main")).toBe(before);
  });

  it("detects merge conflicts at integration instead of clobbering the target", async () => {
    const p = await h.createProject();
    const agent = await h.createAgent("coder", { scripts: { default: [{ write: { path: "README.md", content: "# agent version\n" } }] } });
    const t = await h.createTask({ projectId: p.id, title: "conflict", assignedAgentId: agent.id });
    await h.worker().start();
    await h.waitFor(t.id, ["AWAITING_APPROVAL"]);
    // Someone else changes README on main meanwhile.
    h.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "noop");
    await import("node:fs/promises").then((fs) => fs.writeFile(`${h.repo}/README.md`, "# human version\n"));
    h.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "human edit");
    const before = h.git("rev-parse", "main");
    const { task, integration } = await h.engine.approvals.decide(t.id, "approved", "", "user:x");
    expect(integration).toMatchObject({ ok: false, reason: "merge_conflict", conflicts: ["README.md"] });
    expect(task.status).toBe("FAILED");
    expect(h.git("rev-parse", "main")).toBe(before);
    expect(h.git("status", "--porcelain")).toBe("");
  });
});
