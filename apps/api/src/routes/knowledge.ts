import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Id, KnowledgeAction, KnowledgeStatus, KnowledgeType, PublishKnowledge } from "@agentmesh/contracts";
import type { Engine } from "@agentmesh/engine-kernel";
import type { Viewer } from "@agentmesh/shared-memory";
import { assertProjectAccess, requireRole } from "../auth.ts";

const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.split(",").filter(Boolean) : v), z.array(item)).optional();

export const knowledgeRoutes: FastifyPluginAsyncZod<{ engine: Engine }> = async (app, { engine }) => {
  const viewer = (req: { principal: { actor: string; role: "admin" | "operator" | "viewer"; projectIds: string[] | null } }): Viewer => ({
    kind: "user",
    actor: req.principal.actor,
    role: req.principal.role,
    projectIds: req.principal.projectIds,
  });

  /** List (no query) or hybrid search (query and/or paths). Humans may filter on any status. */
  app.get(
    "/api/v1/knowledge",
    {
      schema: {
        tags: ["knowledge"],
        querystring: z.object({
          projectId: Id,
          q: z.string().max(1000).default(""),
          types: csv(KnowledgeType),
          statuses: csv(KnowledgeStatus),
          paths: csv(z.string().min(1).max(300)),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (req) => {
      assertProjectAccess(req, req.query.projectId);
      const { projectId, q, types, statuses, paths, limit } = req.query;
      if (!q.trim() && !paths?.length) {
        const records = await engine.knowledge.list(projectId, { types, statuses, limit });
        return { mode: "list", results: records.map((record) => ({ record, score: null, signals: null, authoritative: ["verified", "accepted"].includes(record.status) })) };
      }
      const results = await engine.knowledge.search(projectId, { query: q, types: types ?? [], statuses, paths: paths ?? [], limit: Math.min(limit, 50) }, viewer(req));
      return { mode: "search", results };
    },
  );

  app.post("/api/v1/knowledge", { schema: { tags: ["knowledge"], body: PublishKnowledge.extend({ projectId: Id }) } }, async (req, reply) => {
    requireRole(req, "operator");
    assertProjectAccess(req, req.body.projectId);
    const { projectId, ...input } = req.body;
    const r = await engine.knowledge.publish(input, { projectId, actor: req.principal.actor });
    return reply.code(201).send(r);
  });

  app.get("/api/v1/knowledge/conflicts", { schema: { tags: ["knowledge"], querystring: z.object({ projectId: Id }) } }, async (req) => {
    assertProjectAccess(req, req.query.projectId);
    return engine.knowledge.conflicts(req.query.projectId);
  });

  app.get("/api/v1/knowledge/:id", { schema: { tags: ["knowledge"], params: z.object({ id: Id }) } }, async (req) => engine.knowledge.get(req.params.id, viewer(req), null));

  /** verify / accept / dispute / reject / revalidate / add_evidence. */
  app.post("/api/v1/knowledge/:id/actions", { schema: { tags: ["knowledge"], params: z.object({ id: Id }), body: KnowledgeAction } }, async (req) => {
    requireRole(req, "operator");
    return engine.knowledge.act(req.params.id, req.body, viewer(req));
  });
};
