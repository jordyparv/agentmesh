import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { createHarness, initRepo, type Harness } from "../helpers/harness.ts";

let h: Harness;
let url: string;
let admin: string;
let operator: string;
let viewer: string;

const call = async (token: string | null, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${url}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** Reads SSE frames until `pred` matches or timeout. */
async function collectSse(p: string, token: string, pred: (events: { event: string; data: any }[]) => boolean, timeoutMs = 20_000) {
  const ac = new AbortController();
  const res = await fetch(`${url}${p}`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: { event: string; data: any }[] = [];
  let buf = "";
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    while (!pred(out)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return out;
}

beforeAll(async () => {
  h = await createHarness();
  ({ url } = await h.startApi());
  admin = await h.token("admin");
  operator = await h.token("operator");
  viewer = await h.token("viewer");
});
afterAll(async () => h.close());

describe("REST API", () => {
  it("requires authentication and publishes an OpenAPI document", async () => {
    expect((await call(null, "GET", "/api/v1/projects")).status).toBe(401);
    expect((await call("am_" + "0".repeat(48), "GET", "/api/v1/projects")).status).toBe(401);
    const spec = await call(null, "GET", "/api/v1/openapi.json");
    const paths = Object.keys(spec.body.paths);
    for (const g of ["projects", "agents", "tasks", "workflows", "runs", "context", "knowledge", "artifacts", "reviews", "approvals", "integrations", "events"]) {
      expect(paths.some((p) => p.startsWith(`/api/v1/${g}`)), g).toBe(true);
    }
  });

  it("validates repository paths, including symlink tricks", async () => {
    expect((await call(admin, "POST", "/api/v1/projects", { name: "x", repoPath: "relative/path" })).body.error.code).toBe("INVALID_REPO_PATH");
    expect((await call(admin, "POST", "/api/v1/projects", { name: "x", repoPath: path.join(h.repo, "src") })).body.error.code).toBe("NOT_REPO_ROOT");
    expect((await call(operator, "POST", "/api/v1/projects", { name: "x", repoPath: h.repo })).status).toBe(403);
    // A symlink resolves to the real repo; registering it twice via different paths is refused.
    const link = path.join(h.root, "repo-link");
    await symlink(h.repo, link);
    const created = await call(admin, "POST", "/api/v1/projects", { name: "demo", repoPath: link, policy: { validationCommands: [] } });
    expect(created.status).toBe(201);
    expect(created.body.repoPath).toBe(h.repo);
    expect((await call(admin, "POST", "/api/v1/projects", { name: "dup", repoPath: h.repo })).status).toBe(409);
    const repoInfo = await call(viewer, "GET", `/api/v1/projects/${created.body.id}/repository`);
    expect(repoInfo.body.defaultBranch).toBe("main");
    expect(repoInfo.body.recentCommits[0].subject).toBe("init");
  });

  it("scopes tokens to projects", async () => {
    const other = path.join(h.root, "other");
    initRepo(other);
    const p2 = (await call(admin, "POST", "/api/v1/projects", { name: "other", repoPath: other })).body;
    const scoped = await h.token("operator", [p2.id]);
    const visible = (await call(scoped, "GET", "/api/v1/projects")).body.map((p: { id: string }) => p.id);
    expect(visible).toEqual([p2.id]);
    const p1 = (await call(admin, "GET", "/api/v1/projects")).body.find((p: { name: string }) => p.name === "demo");
    expect((await call(scoped, "GET", `/api/v1/projects/${p1.id}`)).status).toBe(403);
    expect((await call(scoped, "POST", "/api/v1/tasks", { projectId: p1.id, title: "nope" })).status).toBe(403);
  });

  it("creates tasks idempotently, enforces roles, and rejects cycles", async () => {
    const p = (await call(admin, "GET", "/api/v1/projects")).body.find((x: { name: string }) => x.name === "demo");
    expect((await call(viewer, "POST", "/api/v1/tasks", { projectId: p.id, title: "x" })).status).toBe(403);
    const a = await call(operator, "POST", "/api/v1/tasks", { projectId: p.id, title: "A" }, { "idempotency-key": "k1" });
    const again = await call(operator, "POST", "/api/v1/tasks", { projectId: p.id, title: "A" }, { "idempotency-key": "k1" });
    expect(again.body.id).toBe(a.body.id);
    const b = await call(operator, "POST", "/api/v1/tasks", { projectId: p.id, title: "B", dependsOn: [a.body.id] });
    const cyc = await call(operator, "PATCH", `/api/v1/tasks/${a.body.id}`, { dependsOn: [b.body.id] });
    expect(cyc.status).toBe(422);
    expect(cyc.body.error.code).toBe("DEPENDENCY_CYCLE");
  });

  it("assigns, runs, streams live status over SSE, then cancels and retries (scenarios 13-15)", async () => {
    const p = (await call(admin, "GET", "/api/v1/projects")).body.find((x: { name: string }) => x.name === "demo");
    const agent = await h.createAgent("slow-coder", { scripts: { default: [{ message: "starting" }, { sleepMs: 60_000 }] } });
    const t = (await call(operator, "POST", "/api/v1/tasks", { projectId: p.id, title: "long job", assignedAgentId: agent.id, allowedPaths: ["src/**"] })).body;
    expect(t.status).toBe("PENDING");
    expect(t.assignmentMode).toBe("manual");
    const ssePromise = collectSse(`/api/v1/events/stream?taskId=${t.id}`, viewer, (evs) => evs.some((e) => e.event === "agent.message"));
    await new Promise((r) => setTimeout(r, 300));
    expect((await call(operator, "POST", `/api/v1/tasks/${t.id}/actions`, { action: "start" })).status).toBe(200);
    await h.worker().start();
    const evs = await ssePromise;
    const statuses = evs.filter((e) => e.event === "task.status").map((e) => e.data.payload.to);
    expect(statuses).toEqual(expect.arrayContaining(["READY", "LEASED", "RUNNING"]));
    expect(evs.find((e) => e.event === "agent.message")!.data.payload.message).toBe("starting");

    expect((await call(viewer, "POST", `/api/v1/tasks/${t.id}/actions`, { action: "cancel" })).status).toBe(403);
    const cancelled = await call(operator, "POST", `/api/v1/tasks/${t.id}/actions`, { action: "cancel" });
    expect(cancelled.body.status).toBe("CANCELLED");
    // The worker notices on its next heartbeat and kills the process.
    const deadline = Date.now() + 10_000;
    let runs: { run: { status: string } }[] = [];
    while (Date.now() < deadline) {
      runs = (await call(viewer, "GET", `/api/v1/tasks/${t.id}/runs`)).body;
      if (runs[0]?.run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(runs[0]!.run.status).toBe("cancelled");
    const retried = await call(operator, "POST", `/api/v1/tasks/${t.id}/actions`, { action: "retry" });
    expect(retried.body.status).toBe("READY");
    const running = await h.waitFor(t.id, ["RUNNING"]);
    expect(running.attempt).toBe(2);
    await call(operator, "POST", `/api/v1/tasks/${t.id}/actions`, { action: "cancel" });
  });

  it("prevents unauthorized merges (scenario 12)", async () => {
    const p = (await call(admin, "GET", "/api/v1/projects")).body.find((x: { name: string }) => x.name === "demo");
    const agent = await h.createAgent("coder", { scripts: { default: [{ write: { path: "src/merge-me.ts", content: "export const m = 1;\n" } }] } });
    const t = (await call(operator, "POST", "/api/v1/tasks", { projectId: p.id, title: "mergeable", assignedAgentId: agent.id, allowedPaths: ["src/**"], autoStart: true })).body;
    await h.waitFor(t.id, ["AWAITING_APPROVAL"]);
    const review = await call(viewer, "GET", `/api/v1/reviews/${t.id}`);
    expect(review.body.diff).toContain("+export const m = 1;");
    expect(review.body.mergePreview.clean).toBe(true);
    expect(review.body.requirements.humanApprovalRequired).toBe(true);
    expect((await call(viewer, "POST", `/api/v1/approvals/${t.id}`, { decision: "approved" })).status).toBe(403);
    expect((await call("amr_" + "a".repeat(48), "POST", `/api/v1/approvals/${t.id}`, { decision: "approved" })).status).toBe(401);
    expect(h.git("ls-tree", "-r", "--name-only", "main")).not.toContain("src/merge-me.ts");
    const ok = await call(operator, "POST", `/api/v1/approvals/${t.id}`, { decision: "approved", comment: "ship it" });
    expect(ok.body.integration.ok).toBe(true);
    expect(ok.body.task.status).toBe("COMPLETED");
    expect(h.git("ls-tree", "-r", "--name-only", "main")).toContain("src/merge-me.ts");
    expect((await call(operator, "POST", `/api/v1/approvals/${t.id}`, { decision: "approved" })).status).toBe(409);
  });

  it("serves dashboard stats from live data", async () => {
    const s = (await call(viewer, "GET", "/api/v1/stats")).body;
    expect(s.projects.length).toBe(2);
    expect(s.tasks.completed).toBeGreaterThanOrEqual(1);
    expect(s.runs.total).toBeGreaterThanOrEqual(2);
    expect(s.agents.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(["coder", "slow-coder"]));
  });
});
