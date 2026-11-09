import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { COLLABORATION_OPS, DomainError } from "@agentmesh/contracts";
import type { AgentSession, Engine } from "@agentmesh/engine-kernel";

declare module "fastify" {
  interface FastifyRequest {
    agentSession: AgentSession;
  }
}

/**
 * Agent collaboration endpoint, used by the MCP server. Authenticated only with run-scoped
 * agent tokens (amr_...); user tokens are not accepted here and agent tokens are not
 * accepted anywhere else.
 */
export const agentToolRoutes: FastifyPluginAsyncZod<{ engine: Engine }> = async (app, { engine }) => {
  app.addHook("onRequest", async (req) => {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
    if (!m) throw new DomainError("UNAUTHENTICATED", "Missing agent token", 401);
    req.agentSession = await engine.collaboration.authenticate(m[1]!);
  });

  app.get("/api/v1/agent-tools", { schema: { tags: ["agent-tools"] } }, async (req) => ({ session: { taskId: req.agentSession.taskId, runId: req.agentSession.runId, projectId: req.agentSession.projectId }, operations: COLLABORATION_OPS }));

  app.post("/api/v1/agent-tools/:op", { schema: { tags: ["agent-tools"], params: z.object({ op: z.enum(COLLABORATION_OPS) }), body: z.unknown() } }, async (req) =>
    engine.collaboration.invoke(req.agentSession, req.params.op, req.body),
  );
};
