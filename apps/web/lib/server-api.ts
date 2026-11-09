import "server-only";

/**
 * Server-side connection to the AgentMesh API. The token is read from the server
 * environment and is never sent to the browser; browsers talk to /api/proxy.
 */
export function apiTarget(): { url: string; token: string } {
  const url = process.env.AGENTMESH_API_URL ?? "http://127.0.0.1:4000";
  const token = process.env.AGENTMESH_API_TOKEN ?? "";
  return { url: url.replace(/\/$/, ""), token };
}
