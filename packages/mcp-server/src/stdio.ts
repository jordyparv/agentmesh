#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, httpCaller } from "./index.ts";

/**
 * Usage: agentmesh-mcp --api-url http://127.0.0.1:4000 --token-file /path/to/token
 * (or AGENTMESH_API_URL / AGENTMESH_AGENT_TOKEN in the environment).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const apiUrl = arg("--api-url") ?? process.env.AGENTMESH_API_URL;
const tokenFile = arg("--token-file");
if (!apiUrl || (!tokenFile && !process.env.AGENTMESH_AGENT_TOKEN)) {
  process.stderr.write("agentmesh-mcp: --api-url and --token-file (or AGENTMESH_API_URL/AGENTMESH_AGENT_TOKEN) are required\n");
  process.exit(2);
}
const readToken = tokenFile ? () => readFile(tokenFile, "utf8") : async () => process.env.AGENTMESH_AGENT_TOKEN!;
const server = createMcpServer(httpCaller(apiUrl, readToken));
await server.connect(new StdioServerTransport());
