import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { boardColumn, Id, type TaskStatus } from "@agentmesh/contracts";
import { agents, knowledgeRecords, projects, runs, tasks } from "@agentmesh/database";
import { activeLoads, toAgent, type Engine } from "@agentmesh/engine-kernel";
import { assertProjectAccess, projectScope } from "../auth.ts";

const NONE = "00000000-0000-0000-0000-000000000000";

/** Dashboard aggregates, computed from live data only. */
export const statsRoutes: FastifyPluginAsyncZod<{ engine: Engine }> = async (app, { engine }) => {
  const db = engine.db;
  app.get("/api/v1/stats", { schema: { tags: ["stats"], querystring: z.object({ projectId: Id.optional(), days: z.coerce.number().int().min(1).max(90).default(7) }) } }, async (req) => {
    let scope: string[] | null = projectScope(req);
    if (req.query.projectId) {
      assertProjectAccess(req, req.query.projectId);
      scope = [req.query.projectId];
    }
    const inScope = (col: Parameters<typeof eq>[0]): SQL[] => (scope ? [inArray(col, scope.length ? scope : [NONE])] : []);
    const byStatus = await db.select({ status: tasks.status, n: sql<number>`count(*)::int` }).from(tasks).where(and(...inScope(tasks.projectId))).groupBy(tasks.status);
    const columns: Record<string, number> = { backlog: 0, ready: 0, running: 0, blocked: 0, review: 0, completed: 0, failed: 0 };
    for (const s of byStatus) columns[boardColumn(s.status as TaskStatus)]! += Number(s.n);
    const since = new Date(Date.now() - req.query.days * 86_400_000);
    const recentRuns = await db
      .select({ run: runs, taskTitle: tasks.title, projectId: tasks.projectId, agentName: agents.name })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(...inScope(tasks.projectId), gte(runs.startedAt, since)))
      .orderBy(desc(runs.startedAt))
      .limit(500);
    const finished = recentRuns.filter((r) => r.run.finishedAt);
    const durations = finished.map((r) => r.run.finishedAt!.getTime() - r.run.startedAt.getTime()).sort((a, b) => a - b);
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, runsWithUsage: 0 };
    for (const r of recentRuns) {
      const u = r.run.usage as Record<string, number>;
      if (u.inputTokens || u.outputTokens || u.costUsd) usage.runsWithUsage++;
      usage.inputTokens += u.inputTokens ?? 0;
      usage.outputTokens += u.outputTokens ?? 0;
      usage.costUsd += u.costUsd ?? 0;
    }
    const outcomes: Record<string, number> = {};
    for (const r of recentRuns) outcomes[r.run.status] = (outcomes[r.run.status] ?? 0) + 1;
    const loads = await activeLoads(db);
    const agentRows = (await db.select().from(agents).orderBy(agents.name)).map((a) => toAgent(a, loads.get(a.id) ?? 0));
    const projectRows = await db.select({ id: projects.id, name: projects.name, repoPath: projects.repoPath, defaultBranch: projects.defaultBranch }).from(projects).where(and(...inScope(projects.id)));
    const knowledge = await db
      .select({ id: knowledgeRecords.id, projectId: knowledgeRecords.projectId, type: knowledgeRecords.type, title: knowledgeRecords.title, status: knowledgeRecords.status, sourceActor: knowledgeRecords.sourceActor, createdAt: knowledgeRecords.createdAt })
      .from(knowledgeRecords)
      .where(and(...inScope(knowledgeRecords.projectId)))
      .orderBy(desc(knowledgeRecords.createdAt))
      .limit(10);
    const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]! : null);
    return {
      projects: projectRows,
      agents: agentRows,
      tasks: columns,
      reviewQueue: columns.review,
      runs: {
        windowDays: req.query.days,
        total: recentRuns.length,
        outcomes,
        durationMs: { p50: pct(0.5), p90: pct(0.9), max: durations.at(-1) ?? null },
        usage: { ...usage, costUsd: Number(usage.costUsd.toFixed(4)) },
        recent: recentRuns.slice(0, 15).map((r) => ({
          id: r.run.id,
          taskId: r.run.taskId,
          taskTitle: r.taskTitle,
          agentName: r.agentName,
          status: r.run.status,
          startedAt: r.run.startedAt.toISOString(),
          durationMs: r.run.finishedAt ? r.run.finishedAt.getTime() - r.run.startedAt.getTime() : null,
          usage: r.run.usage,
        })),
      },
      knowledge,
    };
  });
};
