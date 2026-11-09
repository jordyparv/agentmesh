import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { CreateWorkflow, Id, RunWorkflow, UpdateWorkflow } from "@agentmesh/contracts";
import { toTask, type Engine } from "@agentmesh/engine-kernel";
import { assertProjectAccess, requireRole } from "../auth.ts";

export const workflowRoutes: FastifyPluginAsyncZod<{ engine: Engine }> = async (app, { engine }) => {
  const wf = engine.workflows;
  const loadAccessible = async (req: Parameters<typeof assertProjectAccess>[0], id: string) => {
    const w = await wf.get(id);
    if (w.projectId) assertProjectAccess(req, w.projectId);
    return w;
  };

  app.get("/api/v1/workflows", { schema: { tags: ["workflows"], querystring: z.object({ projectId: Id.optional() }) } }, async (req) => {
    if (req.query.projectId) assertProjectAccess(req, req.query.projectId);
    const all = await wf.list(req.query.projectId);
    const scope = req.principal.projectIds;
    return scope ? all.filter((w) => !w.projectId || scope.includes(w.projectId)) : all;
  });

  app.get("/api/v1/workflows/:id", { schema: { tags: ["workflows"], params: z.object({ id: Id }) } }, async (req) => loadAccessible(req, req.params.id));

  /** Validates without saving (used live by the builder). */
  app.post("/api/v1/workflows/validate", { schema: { tags: ["workflows"], body: z.object({ graph: z.unknown() }) } }, async (req) => wf.validate(req.body.graph));

  app.post("/api/v1/workflows", { schema: { tags: ["workflows"], body: CreateWorkflow } }, async (req, reply) => {
    requireRole(req, req.body.isTemplate || !req.body.projectId ? "admin" : "operator");
    if (req.body.projectId) assertProjectAccess(req, req.body.projectId);
    return reply.code(201).send(await wf.save(req.body, req.principal.actor));
  });

  app.put("/api/v1/workflows/:id", { schema: { tags: ["workflows"], params: z.object({ id: Id }), body: UpdateWorkflow } }, async (req) => {
    const cur = await loadAccessible(req, req.params.id);
    requireRole(req, cur.isTemplate || !cur.projectId ? "admin" : "operator");
    return wf.save(
      { id: cur.id, projectId: cur.projectId, name: req.body.name ?? cur.name, description: req.body.description ?? cur.description, isTemplate: req.body.isTemplate ?? cur.isTemplate, graph: req.body.graph ?? cur.graph },
      req.principal.actor,
    );
  });

  app.delete("/api/v1/workflows/:id", { schema: { tags: ["workflows"], params: z.object({ id: Id }) } }, async (req, reply) => {
    const cur = await loadAccessible(req, req.params.id);
    requireRole(req, cur.isTemplate || !cur.projectId ? "admin" : "operator");
    await wf.remove(cur.id, req.principal.actor);
    return reply.code(204).send();
  });

  app.post("/api/v1/workflows/:id/runs", { schema: { tags: ["workflows"], params: z.object({ id: Id }), body: RunWorkflow } }, async (req, reply) => {
    requireRole(req, "operator");
    assertProjectAccess(req, req.body.projectId);
    await loadAccessible(req, req.params.id);
    const r = await wf.run(req.params.id, req.body.projectId, req.body.input, req.body.autoStart, req.principal.actor);
    const deps = await engine.tasks.dependencies(r.tasks.map((t) => t.id));
    return reply.code(201).send({ workflowRunId: r.workflowRunId, nodeTasks: r.nodeTasks, tasks: r.tasks.map((t) => toTask(t, deps.get(t.id) ?? [])) });
  });

  app.get("/api/v1/workflows/:id/runs", { schema: { tags: ["workflows"], params: z.object({ id: Id }) } }, async (req) => {
    await loadAccessible(req, req.params.id);
    return wf.runs(req.params.id);
  });
};
