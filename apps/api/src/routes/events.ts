import { and, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Id } from "@agentmesh/contracts";
import { events, tasks } from "@agentmesh/database";
import type { Engine } from "@agentmesh/engine-kernel";
import { assertProjectAccess, projectScope } from "../auth.ts";

const Query = z.object({
  projectId: Id.optional(),
  taskId: Id.optional(),
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  /** "message": omit the SSE event name so EventSource.onmessage receives every event. */
  format: z.enum(["named", "message"]).default("named"),
});

/**
 * Events are read from the durable event table, so the stream survives API restarts and
 * sees events written by worker processes. SSE clients resume with Last-Event-ID.
 */
export const eventRoutes: FastifyPluginAsyncZod<{ engine: Engine; pollMs: number }> = async (app, { engine, pollMs }) => {
  const db = engine.db;

  const filters = async (req: Parameters<typeof assertProjectAccess>[0], q: z.infer<typeof Query>): Promise<SQL[]> => {
    const conds: SQL[] = [];
    if (q.taskId) {
      const t = await engine.tasks.get(q.taskId);
      assertProjectAccess(req, t.projectId);
      conds.push(eq(events.taskId, q.taskId));
    }
    if (q.projectId) {
      assertProjectAccess(req, q.projectId);
      conds.push(eq(events.projectId, q.projectId));
    } else if (!q.taskId) {
      const scope = projectScope(req);
      if (scope) conds.push(inArray(events.projectId, scope.length ? scope : ["00000000-0000-0000-0000-000000000000"]));
    }
    return conds;
  };

  app.get("/api/v1/events", { schema: { tags: ["events"], querystring: Query } }, async (req) => {
    const conds = await filters(req, req.query);
    if (req.query.after !== undefined) {
      return db.select().from(events).where(and(...conds, gt(events.id, req.query.after))).orderBy(events.id).limit(req.query.limit);
    }
    return (await db.select().from(events).where(and(...conds)).orderBy(desc(events.id)).limit(req.query.limit)).reverse();
  });

  app.get("/api/v1/events/stream", { schema: { tags: ["events"], querystring: Query } }, async (req, reply) => {
    const conds = await filters(req, req.query);
    const lastHeader = req.headers["last-event-id"];
    let cursor = Number(typeof lastHeader === "string" && /^\d+$/.test(lastHeader) ? lastHeader : (req.query.after ?? NaN));
    if (!Number.isFinite(cursor)) {
      // Start from "now": the client fetches history via /events first.
      const [last] = await db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1);
      cursor = last?.id ?? 0;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 2000\n: connected\n\n`);
    let closed = false;
    let busy = false;
    const tick = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const rows = await db.select().from(events).where(and(...conds, gt(events.id, cursor))).orderBy(events.id).limit(500);
        for (const e of rows) {
          res.write(`id: ${e.id}\n${req.query.format === "named" ? `event: ${e.type}\n` : ""}data: ${JSON.stringify(e)}\n\n`);
          cursor = e.id;
        }
      } catch (e) {
        app.log.error(e);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), pollMs);
    const ping = setInterval(() => !closed && res.write(`: ping\n\n`), 15_000);
    req.raw.on("close", () => {
      closed = true;
      clearInterval(timer);
      clearInterval(ping);
    });
    await tick();
  });

  /** Task status snapshot for cheap polling by agents/CLIs. */
  app.get("/api/v1/events/task-status", { schema: { tags: ["events"], querystring: z.object({ projectId: Id }) } }, async (req) => {
    assertProjectAccess(req, req.query.projectId);
    return db.select({ id: tasks.id, status: tasks.status, updatedAt: tasks.updatedAt }).from(tasks).where(eq(tasks.projectId, req.query.projectId));
  });
};
