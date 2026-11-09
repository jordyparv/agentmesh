/**
 * LIVE provider integration tests. Opt-in: `pnpm test:live` (AGENTMESH_LIVE=1).
 * These spend real model tokens on the installed, authenticated CLIs. They verify:
 *  - Claude Code and Codex run headless inside the bwrap sandbox in an isolated worktree,
 *  - real file changes pass quality gates and wait for approval,
 *  - both CLIs load the AgentMesh MCP server and publish shared knowledge through it,
 *  - a Claude review task receives Codex's discovery in its context.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { events, knowledgeConsumption, knowledgeRecords } from "@agentmesh/database";
import { buildMcpBundle } from "@agentmesh/mcp-server/build";
import { createHarness, type Harness } from "../helpers/harness.ts";

const TIMEOUT = 8 * 60_000;
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ leaseMs: 60_000 });
  await h.startApi();
  h.engine.config.mcpBundle = await buildMcpBundle(path.join(h.root, "agentmesh-mcp.mjs"));
  h.engine.config.heartbeatMs = 2000;
  await h.worker({ maxParallel: 2 }).start();
}, 60_000);
afterAll(async () => h?.close());

// Distinct findings per agent: identical statements would (correctly) be deduplicated into one record.
const FINDINGS = {
  Claude: { statement: "README.md is a one-line placeholder with no setup or usage instructions.", path: "README.md", excerpt: "# demo" },
  Codex: { statement: "src/index.ts only exports a numeric constant x; the package has no entry-point logic yet.", path: "src/index.ts", excerpt: "export const x = 1;" },
};
const publishInstruction = (who: keyof typeof FINDINGS) =>
  `After creating the file, call the MCP tool knowledge_publish (server "agentmesh") exactly once with: type "technical_discovery", title "${who} live discovery", statement "${FINDINGS[who].statement}", affectedPaths ["${FINDINGS[who].path}"], evidence [{"kind":"file","reference":"${FINDINGS[who].path}:1","excerpt":"${FINDINGS[who].excerpt}"}]. Do not do anything else.`;

describe("live providers", () => {
  it(
    "Claude Code implements in the sandbox and publishes via MCP",
    async () => {
      const p = await h.createProject({ validationCommands: ["grep -qx 'hello from claude' claude.txt"], maxAttempts: 1 });
      const [a] = await h.db.db.insert((await import("@agentmesh/database")).agents).values({ name: "claude-live", kind: "claude", maxConcurrency: 1, config: { model: "haiku", maxTurns: 12 }, permissions: {} }).returning();
      const agent = await h.engine.probeAgent(a!.id);
      expect(agent.health, agent.probeDetail).toBe("healthy");
      const t = await h.createTask({
        projectId: p.id,
        title: "Create claude.txt",
        description: `Create a file named claude.txt in the repository root containing exactly the single line: hello from claude\n${publishInstruction("Claude")}`,
        assignedAgentId: agent.id,
        allowedPaths: ["claude.txt"],
        timeoutMs: 5 * 60_000,
      });
      const done = await h.waitFor(t.id, ["AWAITING_APPROVAL", "FAILED"], TIMEOUT);
      const evs = await h.db.db.select().from(events).where(eq(events.taskId, t.id));
      expect(done.status, `${JSON.stringify(done.error)}\n${evs.filter((e) => e.type.includes("error") || e.type === "agent.stderr").map((e) => JSON.stringify(e.payload)).join("\n").slice(0, 3000)}`).toBe("AWAITING_APPROVAL");
      const [k] = await h.db.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.title, "Claude live discovery"));
      expect(k, "knowledge_publish via MCP did not happen").toBeDefined();
      expect(k!.sourceAgentId).toBe(agent.id);
      const r = await h.engine.approvals.decide(t.id, "approved", "live test", "user:live");
      expect(r.integration?.ok).toBe(true);
      expect(h.git("show", "main:claude.txt")).toBe("hello from claude");
    },
    TIMEOUT,
  );

  it(
    "Codex implements, publishes via MCP; a Claude review receives the discovery",
    async () => {
      let [p] = await h.db.db.select().from((await import("@agentmesh/database")).projects);
      if (!p) p = await h.createProject({ maxAttempts: 1 });
      const { agents } = await import("@agentmesh/database");
      const [c] = await h.db.db.insert(agents).values({ name: "codex-live", kind: "codex", maxConcurrency: 1, config: {}, permissions: {} }).returning();
      const codex = await h.engine.probeAgent(c!.id);
      expect(codex.health, codex.probeDetail).toBe("healthy");
      let [claude] = await h.db.db.select().from(agents).where(eq(agents.name, "claude-live"));
      if (!claude) [claude] = await h.db.db.insert(agents).values({ name: "claude-live", kind: "claude", maxConcurrency: 1, config: { model: "haiku", maxTurns: 12 }, permissions: {} }).returning();
      await h.engine.probeAgent(claude!.id);
      const impl = await h.createTask({
        projectId: p!.id,
        title: "Create codex.txt",
        description: `Create a file named codex.txt in the repository root containing exactly the single line: hello from codex\n${publishInstruction("Codex")}`,
        assignedAgentId: codex.id,
        allowedPaths: ["codex.txt"],
        timeoutMs: 5 * 60_000,
      });
      const review = await h.createTask({ projectId: p!.id, title: "Review codex.txt", kind: "review", description: "Review the change. Mention any shared discovery you were given.", assignedAgentId: claude!.id, dependsOn: [impl.id], timeoutMs: 5 * 60_000 });
      const implDone = await h.waitFor(impl.id, ["AWAITING_APPROVAL", "FAILED"], TIMEOUT);
      const evs = await h.db.db.select().from(events).where(eq(events.taskId, impl.id));
      expect(implDone.status, `${JSON.stringify(implDone.error)}\n${evs.filter((e) => e.type.includes("error") || e.type === "agent.stderr").map((e) => JSON.stringify(e.payload)).join("\n").slice(0, 3000)}`).toBe("AWAITING_APPROVAL");
      const [k] = await h.db.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.sourceTaskId, impl.id));
      const trace = (await h.db.db.select().from(events).where(eq(events.taskId, impl.id))).map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 400)}`).join("\n");
      expect(k, `codex did not publish via MCP\n${trace}`).toBeDefined();
      const reviewDone = await h.waitFor(review.id, ["COMPLETED", "FAILED"], TIMEOUT);
      expect(reviewDone.status, JSON.stringify(reviewDone.error)).toBe("COMPLETED");
      expect((reviewDone.result as { structuredOutput?: { verdict?: string } }).structuredOutput?.verdict).toMatch(/approve|request_changes/);
      const consumed = await h.db.db.select().from(knowledgeConsumption).where(and(eq(knowledgeConsumption.taskId, review.id), eq(knowledgeConsumption.knowledgeId, k!.id)));
      expect(consumed.length).toBeGreaterThan(0);
    },
    TIMEOUT * 2,
  );
});
