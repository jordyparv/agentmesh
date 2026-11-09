import { and, desc, eq, gt, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { CreateTask, Id, notFound, TaskAction, TASK_STATUSES, UpdateTask } from "@agentmesh/contracts";
import { agents, artifacts, contextSnapshots, events, knowledgeConsumption, knowledgeRecords, runs, tasks, validations } from "@agentmesh/database";
import { toTask, type Engine } from "@agentmesh/engine-kernel";
import { assertProjectAccess, projectScope, requireRole } from "../auth.ts";

const NONE = "00000000-0000-0000-0000-000000000000";

export const taskRoutes: FastifyPluginAsyncZod<{ engine: Engine }> = async (app, { engine }) => {
  const db = engine.db;
  const loadTask = async (req: Parameters<typeof assertProjectAccess>[0], id: string) => {
    const t = await engine.tasks.get(id);
    assertProjectAccess(req, t.projectId);
    return t;
  };
  const withDeps = async (rows: (typeof tasks.$inferSelect)[]) => {
    const deps = await engine.tasks.dependencies(rows.map((r) => r.id));
    return rows.map((r) => toTask(r, deps.get(r.id) ?? []));
  };

  app.get(
    "/api/v1/tasks",
    {
      schema: {
        tags: ["tasks"],
        querystring: z.object({ projectId: Id.optional(), status: z.enum(TASK_STATUSES).optional(), agentId: Id.optional(), limit: z.coerce.number().int().min(1).max(1000).default(500) }),
      },
    },
    async (req) => {
      const conds: SQL[] = [];
      if (req.query.projectId) {
        assertProjectAccess(req, req.query.projectId);
        conds.push(eq(tasks.projectId, req.query.projectId));
      } else {
        const scope = projectScope(req);
        if (scope) conds.push(inArray(tasks.projectId, scope.length ? scope : [NONE]));
      }
      if (req.query.status) conds.push(eq(tasks.status, req.query.status));
      if (req.query.agentId) conds.push(eq(tasks.assignedAgentId, req.query.agentId));
      const rows = await db.select().from(tasks).where(and(...conds)).orderBy(desc(tasks.updatedAt)).limit(req.query.limit);
      return withDeps(rows);
    },
  );

  app.post("/api/v1/tasks", { schema: { tags: ["tasks"], body: CreateTask, headers: z.object({ "idempotency-key": z.string().min(1).max(200).optional() }).passthrough() } }, async (req, reply) => {
    requireRole(req, "operator");
    assertProjectAccess(req, req.body.projectId);
    const key = req.headers["idempotency-key"];
    const t = await engine.tasks.create(req.body, req.principal.actor, typeof key === "string" ? { idempotencyKey: key } : {});
    const [view] = await withDeps([t]);
    return reply.code(201).send(view);
  });

  app.get("/api/v1/tasks/:id", { schema: { tags: ["tasks"], params: z.object({ id: Id }) } }, async (req) => {
    const t = await loadTask(req, req.params.id);
    const [view] = await withDeps([t]);
    const [agent] = t.assignedAgentId ? await db.select({ id: agents.id, name: agents.name, kind: agents.kind }).from(agents).where(eq(agents.id, t.assignedAgentId)) : [];
    const related = await db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, kind: tasks.kind, origin: tasks.origin })
      .from(tasks)
      .where(or(eq(tasks.parentTaskId, t.id), eq(tasks.requestedByTaskId, t.id)));
    const deps = view!.dependsOn.length ? await db.select({ id: tasks.id, title: tasks.title, status: tasks.status, kind: tasks.kind }).from(tasks).where(inArray(tasks.id, view!.dependsOn)) : [];
    return { ...view!, agent: agent ?? null, dependencies: deps, children: related };
  });

  app.patch("/api/v1/tasks/:id", { schema: { tags: ["tasks"], params: z.object({ id: Id }), body: UpdateTask } }, async (req) => {
    requireRole(req, "operator");
    await loadTask(req, req.params.id);
    const t = await engine.tasks.update(req.params.id, req.body, req.principal.actor);
    return (await withDeps([t]))[0];
  });

  app.post("/api/v1/tasks/:id/actions", { schema: { tags: ["tasks"], params: z.object({ id: Id }), body: z.object({ action: TaskAction }) } }, async (req) => {
    requireRole(req, "operator");
    await loadTask(req, req.params.id);
    const t = await engine.tasks.action(req.params.id, req.body.action, req.principal.actor);
    return (await withDeps([t]))[0];
  });

  app.get("/api/v1/tasks/:id/runs", { schema: { tags: ["runs"], params: z.object({ id: Id }) } }, async (req) => {
    await loadTask(req, req.params.id);
    return db
      .select({ run: runs, agentName: agents.name, agentKind: agents.kind })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(eq(runs.taskId, req.params.id))
      .orderBy(desc(runs.attempt));
  });

  app.get("/api/v1/runs/:id", { schema: { tags: ["runs"], params: z.object({ id: Id }) } }, async (req) => {
    const [r] = await db.select().from(runs).where(eq(runs.id, req.params.id));
    if (!r) throw notFound("Run", req.params.id);
    await loadTask(req, r.taskId);
    return r;
  });

  app.get(
    "/api/v1/tasks/:id/events",
    { schema: { tags: ["events"], params: z.object({ id: Id }), querystring: z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(2000).default(500) }) } },
    async (req) => {
      await loadTask(req, req.params.id);
      return db.select().from(events).where(and(eq(events.taskId, req.params.id), gt(events.id, req.query.after))).orderBy(events.id).limit(req.query.limit);
    },
  );

  app.get("/api/v1/tasks/:id/validations", { schema: { tags: ["tasks"], params: z.object({ id: Id }) } }, async (req) => {
    await loadTask(req, req.params.id);
    return db.select().from(validations).where(eq(validations.taskId, req.params.id)).orderBy(desc(validations.createdAt));
  });

  app.get("/api/v1/tasks/:id/artifacts", { schema: { tags: ["artifacts"], params: z.object({ id: Id }) } }, async (req) => {
    await loadTask(req, req.params.id);
    return db
      .select({ id: artifacts.id, runId: artifacts.runId, kind: artifacts.kind, name: artifacts.name, sha256: artifacts.sha256, sizeBytes: artifacts.sizeBytes, createdAt: artifacts.createdAt })
      .from(artifacts)
      .where(eq(artifacts.taskId, req.params.id))
      .orderBy(desc(artifacts.createdAt));
  });

  app.get("/api/v1/artifacts/:id", { schema: { tags: ["artifacts"], params: z.object({ id: Id }) } }, async (req) => {
    const [a] = await db.select().from(artifacts).where(eq(artifacts.id, req.params.id));
    if (!a) throw notFound("Artifact", req.params.id);
    await loadTask(req, a.taskId);
    return a;
  });

  app.get("/api/v1/tasks/:id/context", { schema: { tags: ["context"], params: z.object({ id: Id }) } }, async (req) => {
    await loadTask(req, req.params.id);
    return db
      .select({ id: contextSnapshots.id, sha256: contextSnapshots.sha256, sourceCommitSha: contextSnapshots.sourceCommitSha, tokenEstimate: contextSnapshots.tokenEstimate, tokenBudget: contextSnapshots.tokenBudget, createdAt: contextSnapshots.createdAt })
      .from(contextSnapshots)
      .where(eq(contextSnapshots.taskId, req.params.id))
      .orderBy(desc(contextSnapshots.createdAt));
  });

  app.get("/api/v1/context/:id", { schema: { tags: ["context"], params: z.object({ id: Id }) } }, async (req) => {
    const [s] = await db.select().from(contextSnapshots).where(eq(contextSnapshots.id, req.params.id));
    if (!s) throw notFound("Context snapshot", req.params.id);
    await loadTask(req, s.taskId);
    const consumed = await db
      .select({ knowledgeId: knowledgeConsumption.knowledgeId, version: knowledgeConsumption.knowledgeVersion, title: knowledgeRecords.title, status: knowledgeRecords.status })
      .from(knowledgeConsumption)
      .innerJoin(knowledgeRecords, eq(knowledgeRecords.id, knowledgeConsumption.knowledgeId))
      .where(eq(knowledgeConsumption.contextSnapshotId, s.id));
    return { ...s, knowledge: consumed };
  });

  /** Knowledge the task's runs received (context + tool calls) and what it published. */
  app.get("/api/v1/tasks/:id/knowledge", { schema: { tags: ["knowledge"], params: z.object({ id: Id }) } }, async (req) => {
    await loadTask(req, req.params.id);
    const consumed = await db
      .select({ knowledgeId: knowledgeConsumption.knowledgeId, version: knowledgeConsumption.knowledgeVersion, via: knowledgeConsumption.via, runId: knowledgeConsumption.runId, at: knowledgeConsumption.createdAt, title: knowledgeRecords.title, status: knowledgeRecords.status, type: knowledgeRecords.type })
      .from(knowledgeConsumption)
      .innerJoin(knowledgeRecords, eq(knowledgeRecords.id, knowledgeConsumption.knowledgeId))
      .where(eq(knowledgeConsumption.taskId, req.params.id))
      .orderBy(desc(knowledgeConsumption.id))
      .limit(200);
    const published = await db.select().from(knowledgeRecords).where(eq(knowledgeRecords.sourceTaskId, req.params.id)).orderBy(desc(knowledgeRecords.createdAt));
    return { consumed, published: await Promise.all(published.map((p) => engine.knowledge.toRecord(p))) };
  });
};
