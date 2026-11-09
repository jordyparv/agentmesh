import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AgentPermissions, CreateAgent, DomainError, Id, notFound, UpdateAgent } from "@agentmesh/contracts";
import { agents, runs, tasks } from "@agentmesh/database";
import { activeLoads, audit, toAgent, type Engine } from "@agentmesh/engine-kernel";
import { requireRole } from "../auth.ts";

/** Keys that look like credentials are rejected: secrets are referenced by env var name only. */
function assertNoSecrets(config: Record<string, unknown>) {
  for (const k of Object.keys(config)) {
    if (/(key|token|secret|password|credential)/i.test(k)) throw new DomainError("SECRET_IN_CONFIG", `Config key "${k}" looks like a credential. Use permissions.secretEnv to reference an environment variable on the worker instead.`, 422);
  }
}

export const agentRoutes: FastifyPluginAsyncZod<{ engine: Engine }> = async (app, { engine }) => {
  const db = engine.db;

  app.get("/api/v1/integrations", { schema: { tags: ["integrations"] } }, async () => engine.registry.kinds());

  app.get("/api/v1/agents", { schema: { tags: ["agents"] } }, async () => {
    const loads = await activeLoads(db);
    return (await db.select().from(agents).orderBy(agents.name)).map((a) => toAgent(a, loads.get(a.id) ?? 0));
  });

  app.post("/api/v1/agents", { schema: { tags: ["agents"], body: CreateAgent } }, async (req, reply) => {
    requireRole(req, "admin");
    if (!engine.registry.has(req.body.kind)) throw new DomainError("UNKNOWN_ADAPTER", `No adapter for kind "${req.body.kind}"`, 422);
    assertNoSecrets(req.body.config);
    const [a] = await db
      .insert(agents)
      .values({
        name: req.body.name,
        kind: req.body.kind,
        enabled: req.body.enabled,
        maxConcurrency: req.body.maxConcurrency,
        config: req.body.config,
        permissions: AgentPermissions.parse(req.body.permissions),
        capabilityOverride: req.body.capabilities ?? null,
      })
      .returning();
    await audit(db, { actor: req.principal.actor, action: "agent.create", targetType: "agent", targetId: a!.id, detail: { kind: a!.kind, name: a!.name } });
    const probed = await engine.probeAgent(a!.id);
    return reply.code(201).send(toAgent(probed, 0));
  });

  app.get("/api/v1/agents/:id", { schema: { tags: ["agents"], params: z.object({ id: Id }) } }, async (req) => {
    const [a] = await db.select().from(agents).where(eq(agents.id, req.params.id));
    if (!a) throw notFound("Agent", req.params.id);
    return toAgent(a, (await activeLoads(db)).get(a.id) ?? 0);
  });

  app.patch("/api/v1/agents/:id", { schema: { tags: ["agents"], params: z.object({ id: Id }), body: UpdateAgent } }, async (req) => {
    requireRole(req, "admin");
    const [a] = await db.select().from(agents).where(eq(agents.id, req.params.id));
    if (!a) throw notFound("Agent", req.params.id);
    if (req.body.config) assertNoSecrets(req.body.config);
    const [u] = await db
      .update(agents)
      .set({
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}),
        ...(req.body.maxConcurrency !== undefined ? { maxConcurrency: req.body.maxConcurrency } : {}),
        ...(req.body.config !== undefined ? { config: req.body.config } : {}),
        ...(req.body.permissions !== undefined ? { permissions: AgentPermissions.parse({ ...(a.permissions as object), ...req.body.permissions }) } : {}),
        ...(req.body.capabilities !== undefined ? { capabilityOverride: req.body.capabilities } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, a.id))
      .returning();
    await audit(db, { actor: req.principal.actor, action: "agent.update", targetType: "agent", targetId: a.id, detail: req.body });
    return toAgent(u!);
  });

  /** Connectivity test: runs the adapter's probe (binary present, version) without spending model tokens. */
  app.post("/api/v1/agents/:id/probe", { schema: { tags: ["agents"], params: z.object({ id: Id }) } }, async (req) => {
    requireRole(req, "operator");
    return toAgent(await engine.probeAgent(req.params.id));
  });

  app.get("/api/v1/agents/:id/runs", { schema: { tags: ["agents"], params: z.object({ id: Id }) } }, async (req) =>
    db
      .select({ run: runs, taskTitle: tasks.title, projectId: tasks.projectId })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.agentId, req.params.id))
      .orderBy(desc(runs.startedAt))
      .limit(100),
  );
};
