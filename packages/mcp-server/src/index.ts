import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { COLLABORATION_OPS, OP_DESCRIPTIONS, OpInputs, type CollaborationOp } from "@agentmesh/contracts";

/**
 * AgentMesh MCP server. Exposes the collaboration operations as MCP tools to agent CLIs
 * (Claude Code, Codex, ...). It holds no state and no privileges of its own: every call is
 * forwarded to the AgentMesh API with the run-scoped agent token, where it is
 * authenticated, validated, scoped and audited.
 *
 * MCP tool names cannot contain dots, so `knowledge.publish` is exposed as `knowledge_publish`.
 */
export const toolName = (op: CollaborationOp) => op.replace(".", "_");
const opFor = new Map(COLLABORATION_OPS.map((op) => [toolName(op), op]));

export type ToolCaller = (op: CollaborationOp, input: unknown) => Promise<{ ok: boolean; status: number; body: unknown }>;

export function createMcpServer(call: ToolCaller): Server {
  const server = new Server({ name: "agentmesh", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: COLLABORATION_OPS.map((op) => ({
      name: toolName(op),
      description: OP_DESCRIPTIONS[op],
      inputSchema: z.toJSONSchema(OpInputs[op], { io: "input" }) as { type: "object"; [k: string]: unknown },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const op = opFor.get(req.params.name);
    if (!op) return { isError: true, content: [{ type: "text", text: `Unknown tool ${req.params.name}` }] };
    try {
      const r = await call(op, req.params.arguments ?? {});
      return { isError: !r.ok, content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `AgentMesh API unreachable: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });
  return server;
}

/** HTTP caller used by the stdio entry point. Reads the token file on every call (it may be rotated/revoked). */
export function httpCaller(apiUrl: string, readToken: () => Promise<string>): ToolCaller {
  return async (op, input) => {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v1/agent-tools/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${(await readToken()).trim()}` },
      body: JSON.stringify(input ?? {}),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { ok: res.ok, status: res.status, body };
  };
}
