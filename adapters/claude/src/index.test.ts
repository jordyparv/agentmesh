import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "./index.ts";

describe("claude adapter args", () => {
  it("denies write tools for read-only tasks", () => {
    const a = buildClaudeArgs({ sandbox: "read-only" }, {});
    const denied = a.slice(a.indexOf("--disallowedTools") + 1);
    expect(denied).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", "WebFetch"]));
    expect(a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"))).toEqual(["Read", "Glob", "Grep"]);
    expect(a).toContain("default");
  });
  it("accepts edits for write tasks and passes structured output schema", () => {
    const a = buildClaudeArgs({ sandbox: "workspace-write", outputSchema: { type: "object" } }, { model: "x" });
    expect(a).toContain("acceptEdits");
    expect(a[a.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  });
  it("loads only the AgentMesh MCP server and allows its tools", () => {
    const a = buildClaudeArgs({ sandbox: "workspace-write", mcp: { name: "agentmesh", command: "/usr/bin/node", args: ["/b.mjs"], env: {} } }, {});
    const cfg = JSON.parse(a[a.indexOf("--mcp-config") + 1]!);
    expect(cfg.mcpServers.agentmesh).toEqual({ type: "stdio", command: "/usr/bin/node", args: ["/b.mjs"], env: {} });
    expect(a).toContain("--strict-mcp-config");
    expect(a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"))).toContain("mcp__agentmesh");
  });
});
