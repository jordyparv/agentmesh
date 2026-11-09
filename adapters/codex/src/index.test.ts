import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "./index.ts";

describe("codex adapter args", () => {
  it("uses only verified codex exec flags", () => {
    const a = buildCodexArgs({ workdir: "/w", sandbox: "read-only" }, { model: "m" }, { schema: "/s.json", lastMessage: "/o.txt" });
    expect(a).toEqual(["exec", "--json", "-C", "/w", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-m", "m", "--output-schema", "/s.json", "-o", "/o.txt", "-"]);
  });

  it("registers the AgentMesh MCP server with auto-approved tools", () => {
    const a = buildCodexArgs({ workdir: "/w", sandbox: "workspace-write", mcp: { name: "agentmesh", command: "/usr/bin/node", args: ["/b.mjs", "--token-file", "/t"], env: {} } }, {}, { lastMessage: "/o.txt" });
    expect(a).toEqual(expect.arrayContaining(['mcp_servers.agentmesh.command="/usr/bin/node"', 'mcp_servers.agentmesh.args=["/b.mjs","--token-file","/t"]', 'mcp_servers.agentmesh.default_tools_approval_mode="approve"']));
    expect(a.join(" ")).not.toMatch(/amr_/);
  });
});
