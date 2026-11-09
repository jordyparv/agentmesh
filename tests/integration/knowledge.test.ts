import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { knowledgeConsumption, knowledgeRecords } from "@agentmesh/database";
import type { Viewer } from "@agentmesh/shared-memory";
import { createHarness, type Harness } from "../helpers/harness.ts";

let h: Harness;
let projectId: string;
let otherProjectId: string;
let taskA: string;
let taskB: string;
let unrelatedTask: string;
let agentA: string;
let agentB: string;

const human = (): Viewer => ({ kind: "user", actor: "user:alice", role: "operator", projectIds: null });
const agent = (agentId: string, taskId: string, pid = projectId): Viewer => ({ kind: "agent", actor: `agent:${agentId}`, agentId, projectId: pid, taskId, runId: null });

beforeAll(async () => {
  h = await createHarness();
  const p = await h.createProject();
  projectId = p.id;
  const other = await h.db.db.insert((await import("@agentmesh/database")).projects).values({ name: "other", repoPath: `${h.root}/other`, defaultBranch: "main", policy: {} }).returning();
  otherProjectId = other[0]!.id;
  agentA = (await h.createAgent("codex-sim", { capabilities: ["implement"] })).id;
  agentB = (await h.createAgent("claude-sim", { capabilities: ["review", "plan"] })).id;
  taskA = (await h.createTask({ projectId, title: "implement leasing", autoStart: false })).id;
  taskB = (await h.createTask({ projectId, title: "review leasing", kind: "review", dependsOn: [taskA], autoStart: false })).id;
  unrelatedTask = (await h.createTask({ projectId, title: "docs", autoStart: false })).id;
});
afterAll(async () => h.close());

describe("shared knowledge fabric", () => {
  it("stores agent discoveries as provisional, with provenance and evidence", async () => {
    const { record, deduplicated } = await h.engine.knowledge.publish(
      { type: "technical_discovery", title: "Lease query lacks index", statement: "The lease query scans tasks by status without an index on (status, priority).", affectedPaths: ["src/scheduler.ts"], tags: [], evidence: [{ kind: "file", reference: "src/scheduler.ts:42", excerpt: "select ... where status = 'READY'" }], confidence: 60, relations: [] },
      { projectId, actor: `agent:${agentA}`, agentId: agentA, taskId: taskA, runId: null, commitSha: "abc123" },
    );
    expect(deduplicated).toBe(false);
    expect(record.status).toBe("evidenced"); // evidence attached, still not verified
    expect(record.sourceAgentId).toBe(agentA);
    expect(record.sourceCommitSha).toBe("abc123");
    expect(record.scope).toBe("paths");
    expect(record.evidenceIds).toHaveLength(1);
  });

  it("deduplicates exact and near-duplicate findings, merging evidence", async () => {
    const base = { type: "technical_discovery" as const, tags: [], confidence: 50, relations: [], affectedPaths: ["src/scheduler.ts"] };
    const exact = await h.engine.knowledge.publish(
      { ...base, title: "Same finding, other words in title", statement: "The lease query scans tasks by status without an index on (status, priority).", evidence: [{ kind: "note", reference: "second look", excerpt: "" }] },
      { projectId, actor: `agent:${agentB}`, agentId: agentB, taskId: taskB },
    );
    expect(exact.deduplicated).toBe("exact");
    const near = await h.engine.knowledge.publish(
      { ...base, title: "Lease query lacks index", statement: "The lease query scans the tasks by status without any index on (status, priority)", evidence: [] },
      { projectId, actor: `agent:${agentB}`, agentId: agentB, taskId: taskB },
    );
    expect(near.deduplicated).toBe("near");
    expect(near.record.id).toBe(exact.record.id);
    const all = await h.db.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.projectId, projectId));
    expect(all).toHaveLength(1);
    expect(near.record.evidenceIds.length).toBeGreaterThanOrEqual(2);
  });

  it("hybrid search ranks by text, path and dependency, and records consumption", async () => {
    await h.engine.knowledge.publish(
      { type: "api_contract", title: "Tasks API pagination", statement: "GET /api/v1/tasks returns at most 500 rows ordered by updatedAt.", affectedPaths: ["apps/api/src/routes/tasks.ts"], tags: [], evidence: [], confidence: 50, relations: [] },
      { projectId, actor: "user:alice" },
    );
    const hits = await h.engine.knowledge.search(projectId, { query: "lease index", types: [], paths: [], limit: 5 }, agent(agentB, taskB), { recordAs: "search" });
    expect(hits[0]!.record.title).toBe("Lease query lacks index");
    expect(hits[0]!.signals.fts).toBeGreaterThan(0);
    expect(hits[0]!.signals.dependency).toBe(1); // published by upstream task A
    expect(hits[0]!.authoritative).toBe(false);
    const byPath = await h.engine.knowledge.search(projectId, { query: "", types: [], paths: ["apps/api/**"], limit: 5 }, human());
    expect(byPath.map((x) => x.record.title)).toEqual(["Tasks API pagination"]);
    const consumed = await h.db.db.select().from(knowledgeConsumption).where(eq(knowledgeConsumption.taskId, taskB));
    expect(consumed.some((c) => c.agentId === agentB && c.via === "search")).toBe(true);
  });

  it("validates context retrieval scope: project, agent visibility and task scope (scenario 8)", async () => {
    const restricted = await h.engine.knowledge.publish(
      { type: "known_issue", title: "Credential rotation runbook gap", statement: "Rotation of deploy credentials is undocumented for the billing service.", affectedPaths: [], tags: [], evidence: [], confidence: 50, relations: [], allowedAgentIds: [agentB] },
      { projectId, actor: "user:alice" },
    );
    const taskScoped = await h.engine.knowledge.publish(
      { type: "task_context", title: "Scratch notes for leasing task", statement: "Intermediate notes about lease heartbeat timing experiments.", affectedPaths: [], tags: [], evidence: [], confidence: 50, relations: [] },
      { projectId, actor: `agent:${agentA}`, agentId: agentA, taskId: taskA },
    );
    expect(taskScoped.record.scope).toBe("task");
    const titles = async (v: Viewer, q: string) => (await h.engine.knowledge.search(projectId, { query: q, types: [], paths: [], limit: 20 }, v)).map((x) => x.record.id);
    expect(await titles(agent(agentA, taskA), "credential rotation billing")).not.toContain(restricted.record.id);
    expect(await titles(agent(agentB, taskB), "credential rotation billing")).toContain(restricted.record.id);
    // task-scoped knowledge: visible to downstream task B, invisible to an unrelated task.
    expect(await titles(agent(agentB, taskB), "lease heartbeat timing notes")).toContain(taskScoped.record.id);
    expect(await titles(agent(agentB, unrelatedTask), "lease heartbeat timing notes")).not.toContain(taskScoped.record.id);
    await expect(h.engine.knowledge.get(restricted.record.id, agent(agentA, taskA))).rejects.toThrow(/not found/);
    // Cross-project access is refused outright.
    await expect(h.engine.knowledge.search(otherProjectId, { query: "lease", types: [], paths: [], limit: 5 }, agent(agentA, taskA))).rejects.toThrow(/not scoped/);
  });

  it("enforces verification rules: no self-verification, decisions need humans", async () => {
    const [rec] = await h.db.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.title, "Lease query lacks index"));
    await expect(h.engine.knowledge.act(rec!.id, { action: "verify", comment: "I agree with myself", evidence: [{ kind: "note", reference: "x", excerpt: "" }] }, agent(agentA, taskA))).rejects.toThrow(/own finding/);
    const decision = await h.engine.knowledge.publish(
      { type: "architectural_decision", title: "Use advisory locks for leasing", statement: "Switch task leasing to pg advisory locks.", affectedPaths: [], tags: [], evidence: [], confidence: 50, relations: [] },
      { projectId, actor: `agent:${agentA}`, agentId: agentA, taskId: taskA },
    );
    expect(decision.record.status).toBe("proposed");
    await expect(h.engine.knowledge.act(decision.record.id, { action: "verify", comment: "ok", evidence: [{ kind: "test", reference: "t", excerpt: "" }] }, agent(agentB, taskB))).rejects.toThrow(/human acceptance/);
    await expect(h.engine.knowledge.act(decision.record.id, { action: "accept", comment: "" }, agent(agentB, taskB))).rejects.toThrow(/Only humans/);
    // Unverified decisions never reach the authoritative context section.
    const ctx = await h.engine.knowledge.forContext({ id: taskB, projectId, title: "advisory locks leasing", description: "", allowedPaths: ["**"] }, agentB, []);
    expect(ctx.decisions.map((d) => d.id)).not.toContain(decision.record.id);
    expect(ctx.provisional.map((d) => d.id)).toContain(decision.record.id);
    const verified = await h.engine.knowledge.act(rec!.id, { action: "verify", comment: "confirmed by EXPLAIN", evidence: [{ kind: "test", reference: "explain.txt", excerpt: "Seq Scan on tasks" }] }, agent(agentB, taskB));
    expect(verified.status).toBe("verified");
    expect(verified.verifiedBy).toBe(`agent:${agentB}`);
    const accepted = await h.engine.knowledge.act(decision.record.id, { action: "accept", comment: "agreed in design review" }, human());
    expect(accepted.status).toBe("accepted");
    const ctx2 = await h.engine.knowledge.forContext({ id: taskB, projectId, title: "x", description: "", allowedPaths: ["**"] }, agentB, []);
    expect(ctx2.decisions.map((d) => d.id)).toContain(decision.record.id);
  });

  it("marks knowledge stale when affected code changes and keeps it out of context until revalidated (scenario 9)", async () => {
    const [rec] = await h.db.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.title, "Lease query lacks index"));
    expect(rec!.status).toBe("verified");
    // A change by the record's own source task does not invalidate it.
    expect(await h.engine.knowledge.markStaleForChanges(projectId, ["src/scheduler.ts"], { taskId: taskA, mergeSha: "1".repeat(40) })).toEqual([]);
    const stale = await h.engine.knowledge.markStaleForChanges(projectId, ["src/scheduler.ts", "README.md"], { taskId: unrelatedTask, mergeSha: "2".repeat(40) });
    expect(stale).toEqual([rec!.id]);
    const ctx = await h.engine.knowledge.forContext({ id: taskB, projectId, title: "lease query index", description: "", allowedPaths: ["src/**"] }, agentB, []);
    expect([...ctx.verified, ...ctx.provisional, ...ctx.decisions].map((r) => r.id)).not.toContain(rec!.id);
    // Stale knowledge cannot silently become authoritative again.
    await expect(h.engine.knowledge.act(rec!.id, { action: "verify", comment: "still true", evidence: [{ kind: "test", reference: "t", excerpt: "" }] }, agent(agentB, unrelatedTask))).rejects.toThrow(/revalidate/);
    await expect(h.engine.knowledge.act(rec!.id, { action: "accept", comment: "" }, human())).rejects.toThrow(/revalidate/);
    const reval = await h.engine.knowledge.act(rec!.id, { action: "revalidate", comment: "re-check after refactor" }, human());
    expect(reval.status).toBe("proposed");
    expect(reval.verifiedBy).toBeNull();
  });

  it("supersession takes effect only once the replacement is verified", async () => {
    const old = await h.engine.knowledge.publish({ type: "api_contract", title: "Events endpoint v1", statement: "Events are delivered via long polling on /events/poll.", affectedPaths: [], tags: [], evidence: [], confidence: 50, relations: [] }, { projectId, actor: "user:alice" });
    const replacement = await h.engine.knowledge.publish(
      { type: "api_contract", title: "Events endpoint v2", statement: "Events stream over SSE at /api/v1/events/stream with Last-Event-ID resume.", affectedPaths: [], tags: [], evidence: [], confidence: 50, relations: [{ targetId: old.record.id, relation: "supersedes" }] },
      { projectId, actor: `agent:${agentA}`, agentId: agentA, taskId: taskA },
    );
    expect((await h.engine.knowledge.get(old.record.id, human(), null)).record.status).toBe("proposed");
    await h.engine.knowledge.act(replacement.record.id, { action: "verify", comment: "checked routes", evidence: [{ kind: "file", reference: "apps/api/src/routes/events.ts", excerpt: "" }] }, agent(agentB, taskB));
    const after = await h.engine.knowledge.get(old.record.id, human(), null);
    expect(after.record.status).toBe("superseded");
    expect(after.record.supersededById).toBe(replacement.record.id);
  });

  it("surfaces conflicting knowledge", async () => {
    const a = await h.engine.knowledge.publish({ type: "technical_discovery", title: "Heartbeat interval is 10s", statement: "Workers heartbeat every 10 seconds.", affectedPaths: [], tags: [], evidence: [], confidence: 50, relations: [] }, { projectId, actor: "user:alice" });
    await h.engine.knowledge.publish(
      { type: "technical_discovery", title: "Heartbeat interval is 300ms", statement: "In tests workers heartbeat every 300 milliseconds, not ten seconds.", affectedPaths: [], tags: [], evidence: [], confidence: 50, relations: [{ targetId: a.record.id, relation: "contradicts" }] },
      { projectId, actor: `agent:${agentB}`, agentId: agentB, taskId: taskB },
    );
    const c = await h.engine.knowledge.conflicts(projectId);
    expect(c.contradictions).toHaveLength(1);
    expect(c.contradictions[0]!.to!.id).toBe(a.record.id);
  });
});
