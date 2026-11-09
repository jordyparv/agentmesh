import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { tasks, workflows } from "@agentmesh/database";
import { compileWorkflow } from "@agentmesh/engine-kernel";
import { createHarness, type Harness } from "../helpers/harness.ts";

const WORKFLOWS_DIR = fileURLToPath(new URL("../../workflows", import.meta.url));
let h: Harness;
let p: { id: string };
beforeAll(async () => {
  h = await createHarness();
  p = await h.createProject();
});
afterAll(async () => h.close());

const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, type: "task", label: id, kind, ...extra });

describe("workflow graphs", () => {
  it("rejects cycles, dangling edges and illegal branches", () => {
    const cyc = compileWorkflow({ nodes: [node("a", "implement"), node("b", "review")], edges: [{ id: "1", source: "a", target: "b" }, { id: "2", source: "b", target: "a" }] });
    expect(cyc.ok).toBe(false);
    expect(cyc.issues[0]!.message).toMatch(/Cycle/);
    expect(compileWorkflow({ nodes: [node("a", "implement")], edges: [{ id: "1", source: "a", target: "zzz" }] }).ok).toBe(false);
    const gateBranch = compileWorkflow({ nodes: [node("a", "implement"), { id: "g", type: "approval", label: "g" }, node("b", "review")], edges: [{ id: "1", source: "a", target: "g" }, { id: "2", source: "g", target: "b", condition: "failure" }] });
    expect(gateBranch.ok).toBe(false);
    expect(compileWorkflow({ nodes: [{ id: "s", type: "start", label: "s" }], edges: [] }).ok).toBe(false);
  });

  it("collapses gates, and marks code tasks upstream of an approval node", () => {
    const c = compileWorkflow({
      nodes: [{ id: "s", type: "start", label: "s" }, node("impl", "implement"), node("docs", "implement"), { id: "g", type: "approval", label: "g" }, node("after", "review")],
      edges: [{ id: "1", source: "s", target: "impl" }, { id: "2", source: "impl", target: "g" }, { id: "3", source: "g", target: "after" }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.compiled.tasks.get("impl")!.requiresApproval).toBe(true);
    expect(c.compiled.tasks.get("docs")!.requiresApproval).toBe(false);
    expect(c.compiled.tasks.get("after")!.deps).toEqual([{ nodeId: "impl", condition: "success" }]);
  });

  it("ships valid templates for engineering, bugfix, code-review and visual-qa", async () => {
    const n = await h.engine.workflows.seedTemplates(WORKFLOWS_DIR);
    expect(n).toBe(4);
    expect(await h.engine.workflows.seedTemplates(WORKFLOWS_DIR)).toBe(0); // idempotent
    const list = await h.engine.workflows.list();
    expect(list.filter((w) => w.isTemplate)).toHaveLength(4);
    const eng = list.find((w) => w.name.startsWith("Engineering"))!;
    const run = await h.engine.workflows.run(eng.id, p.id, { goal: "Add dark mode" }, false, "user:alice");
    const byNode = new Map(run.tasks.map((t) => [t.workflowNodeId, t]));
    expect([...byNode.keys()].sort()).toEqual(["implement", "plan", "review", "tests", "visual"]);
    expect(byNode.get("plan")!.title).toBe("Plan: Add dark mode");
    expect(byNode.get("implement")!.requiresApproval).toBe(true);
    const deps = await h.engine.tasks.dependencies([byNode.get("review")!.id, byNode.get("visual")!.id]);
    expect(deps.get(byNode.get("review")!.id)).toEqual([byNode.get("tests")!.id]);
    expect(deps.get(byNode.get("visual")!.id)).toEqual([byNode.get("tests")!.id]);
  });

  it("executes conditional branches: failure path runs, success path blocks", async () => {
    const failing = await h.createAgent("failing-coder", { capabilities: ["implement", "debug"], scripts: { default: [{ exit: 1, stderr: "compile error" }] } });
    const reviewer = await h.createAgent("diagnoser", { capabilities: ["review"], scripts: { review: [{ output: { verdict: "request_changes", summary: "fix failed: compile error", findings: [] } }] } });
    const [bugfix] = await h.db.db.select().from(workflows).where(eq(workflows.name, "Bugfix: reproduce, fix, review"));
    const graph = structuredClone(bugfix!.graph) as { nodes: { id: string; agentId?: string }[] };
    graph.nodes.find((n) => n.id === "fix")!.agentId = failing.id;
    const { workflow } = await h.engine.workflows.save({ projectId: p.id, name: "bugfix (test)", description: "", isTemplate: false, graph }, "user:alice");
    const run = await h.engine.workflows.run(workflow.id, p.id, { goal: "Crash on empty input" }, true, "user:alice");
    await h.worker().start();
    const fix = await h.waitFor(run.nodeTasks.fix!, ["FAILED"]);
    expect(fix.attempt).toBe(2); // retry policy from the node
    const diagnose = await h.waitFor(run.nodeTasks.diagnose!, ["COMPLETED", "FAILED"]);
    expect(diagnose.status).toBe("COMPLETED");
    expect(diagnose.assignedAgentId).toBe(reviewer.id);
    const review = await h.waitFor(run.nodeTasks.review!, ["BLOCKED", "CANCELLED"]);
    expect(review.status).toBe("BLOCKED"); // success edge from a failed task: blocked, not silently skipped
    const [t] = await h.db.db.select().from(tasks).where(eq(tasks.id, run.nodeTasks.diagnose!));
    expect(t!.origin).toBe("workflow");
  });

  it("refuses to save non-executable graphs", async () => {
    await expect(h.engine.workflows.save({ projectId: null, name: "bad", description: "", isTemplate: false, graph: { nodes: [node("a", "implement", { agentId: "00000000-0000-4000-8000-000000000000" })], edges: [] } }, "u")).rejects.toThrow(/not executable/);
  });

  it("skips a failure branch that is not taken", async () => {
    const coder = await h.createAgent("good-coder", { capabilities: ["implement", "debug"], scripts: { default: [{ write: { path: "src/fix.ts", content: "export {};\n" } }] } });
    await h.createAgent("rev", { capabilities: ["review"], scripts: { review: [{ output: { verdict: "approve", summary: "ok", findings: [] } }] } });
    const [bugfix] = await h.db.db.select().from(workflows).where(eq(workflows.name, "Bugfix: reproduce, fix, review"));
    const graph = structuredClone(bugfix!.graph) as { nodes: { id: string; agentId?: string }[] };
    graph.nodes.find((n) => n.id === "fix")!.agentId = coder.id;
    const { workflow } = await h.engine.workflows.save({ projectId: p.id, name: "bugfix ok (test)", description: "", isTemplate: false, graph }, "user:alice");
    const run = await h.engine.workflows.run(workflow.id, p.id, { goal: "Crash on empty input" }, true, "user:alice");
    await h.worker().start();
    await h.waitFor(run.nodeTasks.fix!, ["AWAITING_APPROVAL"]);
    await h.waitFor(run.nodeTasks.review!, ["COMPLETED"]);
    await h.engine.approvals.decide(run.nodeTasks.fix!, "approved", "", "user:alice");
    const diagnose = await h.waitFor(run.nodeTasks.diagnose!, ["CANCELLED", "COMPLETED", "READY", "RUNNING"]);
    expect(diagnose.status).toBe("CANCELLED");
  });
});
