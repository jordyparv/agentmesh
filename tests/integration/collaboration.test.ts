import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { knowledgeRecords, runs, tasks } from "@agentmesh/database";
import { MAX_COLLABORATION_DEPTH } from "@agentmesh/engine-kernel";
import { createMcpServer, httpCaller } from "@agentmesh/mcp-server";
import { buildMcpBundle } from "@agentmesh/mcp-server/build";
import { createHarness, type Harness } from "../helpers/harness.ts";

let h: Harness;
let url: string;
let projectId: string;
let agentId: string;

/** A live session as if a run were executing (the worker normally does this). */
async function session(depth = 0) {
  const t = await h.createTask({ projectId, title: `requester d${depth}`, autoStart: false });
  await h.db.db.update(tasks).set({ collaborationDepth: depth }).where(eq(tasks.id, t.id));
  const [run] = await h.db.db.insert(runs).values({ taskId: t.id, agentId, attempt: 1, workerId: "test", status: "running" }).returning();
  const s = await h.engine.collaboration.issueSession({ id: run!.id, taskId: t.id, agentId }, projectId, 60_000);
  return { ...s, taskId: t.id, runId: run!.id };
}
const tool = async (token: string, op: string, body: unknown) => {
  const res = await fetch(`${url}/api/v1/agent-tools/${op}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on JSON
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  h = await createHarness();
  ({ url } = await h.startApi());
  projectId = (await h.createProject()).id;
  agentId = (await h.createAgent("collab-agent", { capabilities: ["implement", "review"] })).id;
});
afterAll(async () => h.close());

describe("agent collaboration tools", () => {
  it("authenticates run-scoped tokens and rejects user tokens / dead runs", async () => {
    const s = await session();
    expect((await tool(s.token, "task.getStatus", {})).body.id).toBe(s.taskId);
    const user = await h.token("admin");
    expect((await tool(user, "task.getStatus", {})).status).toBe(401);
    // Agent tokens are useless on the human API.
    expect((await fetch(`${url}/api/v1/projects`, { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(401);
    await h.db.db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, s.runId));
    expect((await tool(s.token, "task.getStatus", {})).status).toBe(401);
  });

  it("validates input and audits calls", async () => {
    const s = await session();
    const bad = await tool(s.token, "knowledge.publish", { type: "not-a-type", title: "x", statement: "y" });
    expect(bad.status).toBe(400);
    const ok = await tool(s.token, "task.reportFinding", { severity: "major", title: "Unbounded retry loop", detail: "retry() never caps attempts in src/index.ts", affectedPaths: ["src/index.ts"] });
    expect(ok.status).toBe(200);
    const [rec] = await h.db.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, ok.body.id));
    expect(rec!.type).toBe("known_issue");
    expect(rec!.tags).toContain("severity:major");
    expect(rec!.sourceRunId).toBe(s.runId);
  });

  it("turns help/review requests into traceable scheduled tasks with bounded depth", async () => {
    const s = await session(0);
    const help = await tool(s.token, "agent.requestHelp", { title: "Explain lease semantics", question: "How are leases renewed?", requiredCapabilities: ["review"] });
    expect(help.status).toBe(200);
    const [ht] = await h.db.db.select().from(tasks).where(eq(tasks.id, help.body.taskId));
    expect(ht).toMatchObject({ origin: "help_request", requestedByTaskId: s.taskId, collaborationDepth: 1, status: "PENDING", autoStart: true });
    // Idempotent per run: a retry of the same call does not duplicate the task.
    expect((await tool(s.token, "agent.requestHelp", { title: "Explain lease semantics", question: "How are leases renewed?" })).body.taskId).toBe(help.body.taskId);
    const rv = await tool(s.token, "agent.requestReview", { focus: "error handling" });
    const deps = await h.engine.tasks.dependencies([rv.body.taskId]);
    expect(deps.get(rv.body.taskId)).toEqual([s.taskId]);
    const prop = await tool(s.token, "task.propose", { title: "Add retry jitter", description: "Avoid thundering herd", rationale: "seen in logs" });
    const [pt] = await h.db.db.select().from(tasks).where(eq(tasks.id, prop.body.taskId));
    expect(pt).toMatchObject({ origin: "proposal", autoStart: false });

    const deep = await session(MAX_COLLABORATION_DEPTH);
    const refused = await tool(deep.token, "agent.requestHelp", { title: "Recursive help", question: "help me help you" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/depth limit/);
  });

  it("limits how many tasks one run can create", async () => {
    const s = await session();
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await tool(s.token, "task.propose", { title: `Proposal number ${i}` })).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.at(-1)).toBe(409);
  });

  it("exposes the operations as MCP tools backed by the API", async () => {
    const s = await session();
    const server = createMcpServer(httpCaller(url, async () => s.token));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["agent_requestHelp", "agent_requestReview", "context_refresh", "knowledge_get", "knowledge_publish", "knowledge_search", "knowledge_subscribe", "knowledge_verify", "task_getStatus", "task_propose", "task_reportFinding"].sort(),
    );
    expect(tools.find((t) => t.name === "knowledge_publish")!.inputSchema.required).toEqual(expect.arrayContaining(["type", "title", "statement"]));
    const pub = await client.callTool({ name: "knowledge_publish", arguments: { type: "api_contract", title: "MCP contract", statement: "Tool names use underscores instead of dots." } });
    expect(pub.isError).toBe(false);
    const id = JSON.parse((pub.content as { text: string }[])[0]!.text).id;
    const got = await client.callTool({ name: "knowledge_get", arguments: { id } });
    expect(JSON.parse((got.content as { text: string }[])[0]!.text).record.title).toBe("MCP contract");
    const bad = await client.callTool({ name: "knowledge_get", arguments: { id: "nope" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("runs the bundled stdio MCP server standalone (as agent CLIs launch it)", async () => {
    const s = await session();
    const dir = await mkdtemp(path.join(h.root, "mcp-"));
    const bundle = await buildMcpBundle(path.join(dir, "agentmesh-mcp.mjs"));
    const tokenFile = path.join(dir, "token");
    await writeFile(tokenFile, s.token, { mode: 0o600 });
    const transport = new StdioClientTransport({ command: process.execPath, args: [bundle, "--api-url", url, "--token-file", tokenFile], env: { PATH: process.env.PATH ?? "" } });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    const r = await client.callTool({ name: "task_getStatus", arguments: {} });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text).id).toBe(s.taskId);
    await client.close();
  });

  it("delivers subscription matches through context.refresh", async () => {
    const sub = await session();
    expect((await tool(sub.token, "knowledge.subscribe", { types: ["known_issue"], paths: ["src/**"] })).status).toBe(200);
    const pub = await session();
    await tool(pub.token, "task.reportFinding", { severity: "critical", title: "SQL injection in search", detail: "search() interpolates user input into SQL in src/search.ts", affectedPaths: ["src/search.ts"] });
    await tool(pub.token, "knowledge.publish", { type: "project_knowledge", title: "Unrelated docs fact", statement: "Docs are built with mkdocs." });
    const refresh = await tool(sub.token, "context.refresh", { since: new Date(Date.now() - 60_000).toISOString() });
    expect(refresh.body.notifications.map((n: { title: string }) => n.title)).toEqual(["SQL injection in search"]);
    expect(refresh.body.changed.map((c: { record: { title: string } }) => c.record.title)).toEqual(expect.arrayContaining(["SQL injection in search", "Unrelated docs fact"]));
  });
});
