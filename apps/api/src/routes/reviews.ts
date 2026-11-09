import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { CreateApproval, Id, ProjectPolicy } from "@agentmesh/contracts";
import { agents, approvals, artifacts, projects, runs, taskDependencies, tasks, validations } from "@agentmesh/database";
import { toTask, type Engine } from "@agentmesh/engine-kernel";
import { branchSha, git } from "@agentmesh/workspace-manager";
import { assertProjectAccess, projectScope, requireRole } from "../auth.ts";

const NONE = "00000000-0000-0000-0000-000000000000";

/** Dry-run merge of the validated head into the target branch (no worktree, no ref changes). */
async function mergePreview(repo: string, target: string, headSha: string) {
  try {
    const targetSha = await branchSha(repo, target);
    const r = await git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", targetSha, headSha], { allowFail: true });
    const lines = r.stdout.split("\n").filter(Boolean);
    return { targetSha, clean: r.code === 0, conflicts: r.code === 1 ? lines.slice(1) : [], error: r.code > 1 ? r.stderr.trim() : null };
  } catch (e) {
    return { targetSha: null, clean: false, conflicts: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export const reviewRoutes: FastifyPluginAsyncZod<{ engine: Engine }> = async (app, { engine }) => {
  const db = engine.db;

  /** Review queue: everything awaiting a human decision. */
  app.get("/api/v1/reviews", { schema: { tags: ["reviews"], querystring: z.object({ projectId: Id.optional() }) } }, async (req) => {
    const conds: SQL[] = [eq(tasks.status, "AWAITING_APPROVAL")];
    if (req.query.projectId) {
      assertProjectAccess(req, req.query.projectId);
      conds.push(eq(tasks.projectId, req.query.projectId));
    } else {
      const scope = projectScope(req);
      if (scope) conds.push(inArray(tasks.projectId, scope.length ? scope : [NONE]));
    }
    const rows = await db.select({ task: tasks, projectName: projects.name, agentName: agents.name }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).leftJoin(agents, eq(agents.id, tasks.assignedAgentId)).where(and(...conds)).orderBy(desc(tasks.updatedAt));
    const deps = await engine.tasks.dependencies(rows.map((r) => r.task.id));
    return rows.map((r) => ({ ...toTask(r.task, deps.get(r.task.id) ?? []), projectName: r.projectName, agentName: r.agentName }));
  });

  /** Everything a human needs to decide: diff, gates, reviewer findings, merge preview, requirements. */
  app.get("/api/v1/reviews/:taskId", { schema: { tags: ["reviews"], params: z.object({ taskId: Id }) } }, async (req) => {
    const t = await engine.tasks.get(req.params.taskId);
    assertProjectAccess(req, t.projectId);
    const [project] = await db.select().from(projects).where(eq(projects.id, t.projectId));
    const [run] = await db.select().from(runs).where(and(eq(runs.taskId, t.id), eq(runs.attempt, t.attempt)));
    const arts = run ? await db.select().from(artifacts).where(eq(artifacts.runId, run.id)) : [];
    const gates = run ? await db.select().from(validations).where(eq(validations.runId, run.id)) : [];
    const integrationGates = await db.select().from(validations).where(and(eq(validations.taskId, t.id), eq(validations.stage, "integration"))).orderBy(desc(validations.createdAt));
    // Reviewer findings: read-only review tasks that depend on this task.
    const reviewers = await db
      .select({ task: tasks, agentName: agents.name })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .leftJoin(agents, eq(agents.id, tasks.assignedAgentId))
      .where(and(eq(taskDependencies.dependsOnTaskId, t.id), eq(tasks.kind, "review")));
    const reviews = reviewers.map((r) => {
      const out = (r.task.result as { structuredOutput?: { verdict?: string; summary?: string; findings?: unknown[] } } | null)?.structuredOutput;
      return { taskId: r.task.id, title: r.task.title, status: r.task.status, agentName: r.agentName, verdict: out?.verdict ?? null, summary: out?.summary ?? null, findings: out?.findings ?? [], reviewedSha: r.task.baseSha, current: r.task.baseSha === t.headSha };
    });
    const history = await db.select().from(approvals).where(eq(approvals.taskId, t.id)).orderBy(desc(approvals.createdAt));
    const policy = ProjectPolicy.parse(project!.policy);
    const preview = t.headSha ? await mergePreview(project!.repoPath, project!.defaultBranch, t.headSha) : null;
    const [view] = [toTask(t, (await engine.tasks.dependencies([t.id])).get(t.id) ?? [])];
    return {
      task: view,
      project: { id: project!.id, name: project!.name, defaultBranch: project!.defaultBranch },
      run,
      diff: arts.find((a) => a.kind === "diff")?.content ?? "",
      changedFiles: JSON.parse(arts.find((a) => a.kind === "changed-files")?.content ?? "[]") as { path: string; status: string }[],
      artifacts: arts.filter((a) => a.kind !== "diff").map((a) => ({ id: a.id, kind: a.kind, name: a.name, sizeBytes: a.sizeBytes })),
      gates,
      integrationGates,
      reviews,
      mergePreview: preview,
      requirements: {
        humanApprovalRequired: t.requiresApproval,
        integrationValidation: policy.validationCommands,
        target: project!.defaultBranch,
        headSha: t.headSha,
        pendingReviews: reviews.filter((r) => !["COMPLETED", "FAILED", "CANCELLED"].includes(r.status)).length,
        blockingFindings: reviews.filter((r) => r.verdict === "request_changes").length,
      },
      history,
    };
  });

  app.get("/api/v1/approvals", { schema: { tags: ["approvals"], querystring: z.object({ taskId: Id }) } }, async (req) => {
    const t = await engine.tasks.get(req.query.taskId);
    assertProjectAccess(req, t.projectId);
    return db.select().from(approvals).where(eq(approvals.taskId, t.id)).orderBy(desc(approvals.createdAt));
  });

  /**
   * Approve (validated merge into the default branch), reject, or request changes. This is
   * the only route that integrates agent work; it requires a human operator token.
   */
  app.post("/api/v1/approvals/:taskId", { schema: { tags: ["approvals"], params: z.object({ taskId: Id }), body: CreateApproval } }, async (req) => {
    requireRole(req, "operator");
    const t = await engine.tasks.get(req.params.taskId);
    assertProjectAccess(req, t.projectId);
    const r = await engine.approvals.decide(t.id, req.body.decision, req.body.comment, req.principal.actor);
    return { task: toTask(r.task, (await engine.tasks.dependencies([t.id])).get(t.id) ?? []), integration: r.integration ?? null };
  });
};
