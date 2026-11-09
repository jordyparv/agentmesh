import type { NextRequest } from "next/server";
import { apiTarget } from "@/lib/server-api";

/**
 * Same-origin proxy from the portal to the AgentMesh API. Adds the server-held bearer
 * token. Mutations must be same-origin JSON requests (CSRF protection: cross-site forms
 * cannot send application/json, and the Origin header must match).
 */
export const dynamic = "force-dynamic";

const ALLOWED_PREFIX = /^v1\/(projects|agents|tasks|workflows|runs|context|knowledge|artifacts|reviews|approvals|integrations|events|stats|openapi\.json|health)(\/|$)/;

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const sub = path.join("/");
  if (!ALLOWED_PREFIX.test(sub)) return Response.json({ error: { code: "NOT_FOUND", message: "Unknown API path" } }, { status: 404 });
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (!origin || new URL(origin).host !== host) return Response.json({ error: { code: "CSRF", message: "Cross-origin request refused" } }, { status: 403 });
    if (req.method !== "DELETE" && !(req.headers.get("content-type") ?? "").includes("application/json")) {
      return Response.json({ error: { code: "UNSUPPORTED_MEDIA", message: "JSON required" } }, { status: 415 });
    }
  }
  const { url, token } = apiTarget();
  if (!token) return Response.json({ error: { code: "PORTAL_NOT_CONFIGURED", message: "AGENTMESH_API_TOKEN is not set for the portal. Run `pnpm agentmesh bootstrap`." } }, { status: 503 });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  for (const h of ["content-type", "accept", "last-event-id", "idempotency-key"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${url}/api/${sub}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      signal: req.signal,
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: { code: "API_UNREACHABLE", message: `AgentMesh API unreachable at ${url}` } }, { status: 502 });
  }
  const out = new Headers();
  for (const h of ["content-type", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) out.set("x-accel-buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { forward as GET, forward as POST, forward as PATCH, forward as PUT, forward as DELETE };
