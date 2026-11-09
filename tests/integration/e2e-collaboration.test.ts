/**
 * Complete end-to-end scenario (spec §12), using SIMULATED provider adapters (adapter kind
 * "test"): real processes in the bwrap sandbox, real git worktrees, real API, real
 * collaboration calls over HTTP with run-scoped tokens. Live Codex/Claude runs are
 * covered separately by tests/live (opt-in) and are not claimed here.
 *
 * Claude plans -> Codex implements -> Codex publishes discovery -> Claude retrieves
 * discovery -> Claude reviews -> automated tests pass -> user approves -> engine integrates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agentSessions, contextSnapshots, knowledgeConsumption, knowledgeRecords, runs, tasks } from "@agentmesh/database";
import { createHarness, type Harness } from "../helpers/harness.ts";

let h: Harness;
let url: string;

const DISCOVERY = {
  type: "technical_discovery",
  title: "Rate limiter state is per-process",
  statement: "The in-memory token bucket in src/rate-limit.ts is per-process; multiple API instances need a shared store or limits multiply.",
  affectedPaths: ["src/rate-limit.ts"],
  evidence: [{ kind: "file", reference: "src/rate-limit.ts:1", excerpt: "const buckets = new Map()" }],
};

beforeAll(async () => {
  h = await createHarness();
  ({ url } = await h.startApi());
});
afterAll(async () => h.close());

describe("end-to-end multi-agent collaboration (simulated adapters)", () => {
  it("plans, implements, shares a discovery, reviews with it, validates, and integrates on approval", async () => {
    const project = await h.createProject({ validationCommands: ["test -f src/rate-limit.ts", "grep -q buckets src/rate-limit.ts"], autoStartPlannedTasks: true });
    const claude = await h.createAgent("claude-sim", {
      capabilities: ["plan", "architecture", "review"],
      scripts: {
        plan: [
          { message: "planning" },
          {
            output: {
              tasks: [
                { key: "impl", title: "Implement API rate limiter", description: "Token bucket per client.", kind: "implement", requiredCapabilities: ["implement"], acceptanceCriteria: ["src/rate-limit.ts exists"], dependsOn: [], allowedPaths: ["src/**"] },
                { key: "review", title: "Review API rate limiter", description: "Review the limiter.", kind: "review", requiredCapabilities: ["review"], acceptanceCriteria: [], dependsOn: ["impl"] },
              ],
            },
          },
        ],
        review: [
          { tool: { name: "knowledge.search", args: { query: "rate limiter per-process state" }, required: true } },
          { output: { verdict: "approve", summary: "Limiter is correct for a single instance; see shared discovery about multi-instance state.", findings: [{ severity: "minor", file: "src/rate-limit.ts", message: "Per-process state (known discovery)" }] } },
        ],
      },
    });
    const codex = await h.createAgent("codex-sim", {
      capabilities: ["implement", "test"],
      scripts: {
        implement: [
          { write: { path: "src/rate-limit.ts", content: "const buckets = new Map<string, number>();\nexport const allow = (k: string) => (buckets.get(k) ?? 0) < 10;\n" } },
          { tool: { name: "knowledge.publish", args: DISCOVERY, required: true } },
          { message: "implemented token bucket; published discovery" },
        ],
      },
    });

    // 1. Goal -> planning task, routed by capability (no hardcoded assignment).
    const plan = await h.createTask({ projectId: project.id, title: "Add API rate limiting", kind: "plan", description: "Protect the API from abuse." });
    await h.worker({ maxParallel: 3 }).start();
    const planned = await h.waitFor(plan.id, ["COMPLETED", "FAILED"]);
    expect(planned.status, JSON.stringify(planned.error)).toBe("COMPLETED");
    expect(planned.assignedAgentId).toBe(claude.id);
    const children = await h.db.db.select().from(tasks).where(eq(tasks.parentTaskId, plan.id));
    const impl = children.find((c) => c.kind === "implement")!;
    const review = children.find((c) => c.kind === "review")!;
    expect(children).toHaveLength(2);

    // 2. Codex implements, publishes a discovery; automated tests (quality gates) pass.
    const implDone = await h.waitFor(impl.id, ["AWAITING_APPROVAL", "FAILED"]);
    expect(implDone.status, JSON.stringify(implDone.error)).toBe("AWAITING_APPROVAL");
    expect(implDone.assignedAgentId).toBe(codex.id);
    const [discovery] = await h.db.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.title, DISCOVERY.title));
    expect(discovery).toBeDefined();
    expect(discovery!.sourceAgentId).toBe(codex.id);
    expect(discovery!.sourceTaskId).toBe(impl.id);
    expect(discovery!.status).toBe("evidenced"); // provisional, never auto-verified

    // 3. Claude reviews with the discovery in its context and via search.
    const reviewDone = await h.waitFor(review.id, ["COMPLETED", "FAILED"]);
    expect(reviewDone.status, JSON.stringify(reviewDone.error)).toBe("COMPLETED");
    expect(reviewDone.assignedAgentId).toBe(claude.id);
    const [reviewRun] = await h.db.db.select().from(runs).where(eq(runs.taskId, review.id));
    const [snap] = await h.db.db.select().from(contextSnapshots).where(eq(contextSnapshots.id, reviewRun!.contextSnapshotId!));
    expect(snap!.rendered).toContain(`[K:${discovery!.id}]`);
    expect(snap!.rendered).toMatch(/## Unverified discoveries \(provisional\)\n<context-data source="knowledge">/);
    const consumption = await h.db.db.select().from(knowledgeConsumption).where(and(eq(knowledgeConsumption.knowledgeId, discovery!.id), eq(knowledgeConsumption.agentId, claude.id)));
    expect(consumption.map((c) => c.via).sort()).toEqual(["context", "search"]);
    // Reviewer worked on the implementation's validated head commit.
    expect(reviewDone.baseSha).toBe(implDone.headSha);

    // 4. Review center shows the evidence a human needs.
    const admin = await h.token("operator");
    const rv = (await (await fetch(`${url}/api/v1/reviews/${impl.id}`, { headers: { authorization: `Bearer ${admin}` } })).json()) as any; // test assertions on JSON
    expect(rv.diff).toContain("+const buckets");
    expect(rv.gates.every((g: { passed: boolean }) => g.passed)).toBe(true);
    expect(rv.gates.map((g: { gate: string }) => g.gate)).toEqual(expect.arrayContaining(["command:test -f src/rate-limit.ts", "file_scope"]));
    expect(rv.reviews).toEqual([expect.objectContaining({ verdict: "approve", current: true, agentName: "claude-sim" })]);
    expect(rv.mergePreview.clean).toBe(true);

    // 5. User approves; engine integrates into main after re-validating the merge result.
    expect(h.git("ls-tree", "-r", "--name-only", "main")).not.toContain("src/rate-limit.ts");
    const res = await fetch(`${url}/api/v1/approvals/${impl.id}`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "approved", comment: "lgtm" }) });
    const approved = (await res.json()) as any;
    expect(approved.integration.ok).toBe(true);
    expect(approved.task.status).toBe("COMPLETED");
    expect(h.git("show", "main:src/rate-limit.ts")).toContain("buckets");

    // Run-scoped agent credentials are revoked once runs end.
    const live = await h.db.db.select().from(agentSessions).where(isNull(agentSessions.revokedAt));
    expect(live).toEqual([]);
  });
});
