import path from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { conflict, CreateProject, Id, notFound, ProjectPolicy, UpdateProject } from "@agentmesh/contracts";
import { projects, runs, tasks, agents } from "@agentmesh/database";
import { audit, toProject, type Engine } from "@agentmesh/engine-kernel";
import { branchSha, gitOut, validateRepository } from "@agentmesh/workspace-manager";
import { assertProjectAccess, projectScope, requireRole } from "../auth.ts";

export const projectRoutes: FastifyPluginAsyncZod<{ engine: Engine; allowedRepoRoots?: string[] }> = async (app, { engine, allowedRepoRoots }) => {
  const db = engine.db;
  const load = async (id: string) => {
    const [p] = await db.select().from(projects).where(eq(projects.id, id));
    if (!p) throw notFound("Project", id);
    return p;
  };

  app.get("/api/v1/projects", { schema: { tags: ["projects"] } }, async (req) => {
    const scope = projectScope(req);
    const rows = scope ? await db.select().from(projects).where(inArray(projects.id, scope.length ? scope : ["00000000-0000-0000-0000-000000000000"])) : await db.select().from(projects);
    return rows.map(toProject);
  });

  app.post("/api/v1/projects", { schema: { tags: ["projects"], body: CreateProject } }, async (req, reply) => {
    requireRole(req, "admin");
    const info = await validateRepository(req.body.repoPath, { allowedRoots: allowedRepoRoots, forbiddenRoots: [path.resolve(engine.config.dataDir)] });
    const [dup] = await db.select({ id: projects.id }).from(projects).where(eq(projects.repoPath, info.repoPath));
    if (dup) throw conflict("Repository already registered", { projectId: dup.id });
    const defaultBranch = req.body.defaultBranch ?? info.defaultBranch;
    await branchSha(info.repoPath, defaultBranch);
    const [p] = await db
      .insert(projects)
      .values({ name: req.body.name, repoPath: info.repoPath, defaultBranch, instructions: req.body.instructions, policy: ProjectPolicy.parse(req.body.policy) })
      .returning();
    await audit(db, { actor: req.principal.actor, action: "project.create", targetType: "project", targetId: p!.id, detail: { repoPath: info.repoPath } });
    return reply.code(201).send(toProject(p!));
  });

  app.get("/api/v1/projects/:id", { schema: { tags: ["projects"], params: z.object({ id: Id }) } }, async (req) => {
    assertProjectAccess(req, req.params.id);
    return toProject(await load(req.params.id));
  });

  app.patch("/api/v1/projects/:id", { schema: { tags: ["projects"], params: z.object({ id: Id }), body: UpdateProject } }, async (req) => {
    requireRole(req, "operator");
    assertProjectAccess(req, req.params.id);
    const p = await load(req.params.id);
    if (req.body.policy && req.principal.role !== "admin") requireRole(req, "admin"); // policy changes affect security gates
    if (req.body.defaultBranch) await branchSha(p.repoPath, req.body.defaultBranch);
    const [u] = await db
      .update(projects)
      .set({
        ...(req.body.name ? { name: req.body.name } : {}),
        ...(req.body.defaultBranch ? { defaultBranch: req.body.defaultBranch } : {}),
        ...(req.body.instructions !== undefined ? { instructions: req.body.instructions } : {}),
        ...(req.body.policy ? { policy: ProjectPolicy.parse({ ...(p.policy as object), ...req.body.policy }) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, p.id))
      .returning();
    await audit(db, { actor: req.principal.actor, action: "project.update", targetType: "project", targetId: p.id, detail: req.body });
    return toProject(u!);
  });

  /** Repository context: branches, HEAD of the default branch, recent commits, active AgentMesh worktrees. */
  app.get("/api/v1/projects/:id/repository", { schema: { tags: ["projects"], params: z.object({ id: Id }) } }, async (req) => {
    assertProjectAccess(req, req.params.id);
    const p = await load(req.params.id);
    const branches = (await gitOut(p.repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean);
    const log = (await gitOut(p.repoPath, ["log", "-n", "15", "--format=%H%x1f%an%x1f%aI%x1f%s", p.defaultBranch])).split("\n").filter(Boolean).map((l) => {
      const [sha, author, date, subject] = l.split("\x1f");
      return { sha, author, date, subject };
    });
    const files = (await gitOut(p.repoPath, ["ls-tree", "-r", "--name-only", p.defaultBranch])).split("\n").filter(Boolean);
    return { defaultBranch: p.defaultBranch, headSha: await branchSha(p.repoPath, p.defaultBranch), branches, recentCommits: log, fileCount: files.length, topLevel: [...new Set(files.map((f) => f.split("/")[0]))].slice(0, 100) };
  });

  app.get("/api/v1/projects/:id/history", { schema: { tags: ["projects"], params: z.object({ id: Id }) } }, async (req) => {
    assertProjectAccess(req, req.params.id);
    return db
      .select({ run: runs, taskTitle: tasks.title, agentName: agents.name })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(eq(tasks.projectId, req.params.id))
      .orderBy(desc(runs.startedAt))
      .limit(100);
  });
};
