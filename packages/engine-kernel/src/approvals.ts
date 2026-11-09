import { and, eq, isNull } from "drizzle-orm";
import { conflict, DomainError, forbidden, notFound, ProjectPolicy } from "@agentmesh/contracts";
import { approvals, projects, tasks, validations, type Db } from "@agentmesh/database";
import { buildAgentEnv, gitCommonDir, type Sandbox } from "@agentmesh/execution-runtime";
import { runCommandGates } from "@agentmesh/validation-engine";
import { gitOut, type IntegrationResult, type WorkspaceManager } from "@agentmesh/workspace-manager";
import { audit, publishEvent } from "./events.ts";
import { transition, type TaskRow } from "./tasks.ts";

export type Decision = "approved" | "rejected" | "changes_requested";

/**
 * The only code path that integrates agent work into a protected branch. Integration
 * requires: task in AWAITING_APPROVAL, a human (or policy) approval of the exact validated
 * head commit, a successful merge in an isolated integration worktree, passing integration
 * validation, and an atomic compare-and-swap of the target ref.
 */
export class ApprovalService {
  constructor(
    private d: {
      db: Db;
      workspaces: WorkspaceManager;
      sandbox: Sandbox;
      validationTimeoutMs: number;
      /** Called after a successful integration with the files it changed (knowledge staleness). */
      onIntegrated?: (e: { projectId: string; taskId: string; changedPaths: string[]; mergeSha: string; targetSha: string }) => Promise<void>;
    },
  ) {}

  async decide(taskId: string, decision: Decision, comment: string, actor: string): Promise<{ task: TaskRow; integration?: IntegrationResult }> {
    if (actor.startsWith("agent:") || actor.startsWith("agent-")) throw forbidden("Agents cannot approve or merge work");
    const { db } = this.d;
    const claimed = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
      if (!t) throw notFound("Task", taskId);
      if (t.status !== "AWAITING_APPROVAL") throw conflict(`Task is ${t.status}; only tasks awaiting approval can be decided`);
      if (t.leaseOwner) throw conflict("An integration for this task is already in progress");
      const [a] = await tx.insert(approvals).values({ taskId, decision, actor, comment, headSha: t.headSha }).returning();
      await audit(tx, { actor, action: `approval.${decision}`, targetType: "task", targetId: taskId, detail: { comment, headSha: t.headSha } });
      if (decision === "rejected") {
        return { task: await transition(tx, taskId, "FAILED", { reason: `rejected by ${actor}`, actor, patch: { error: { class: "rejected", message: comment || "rejected by reviewer" } } }), integrate: false };
      }
      if (decision === "changes_requested") {
        return {
          task: await transition(tx, taskId, "READY", {
            reason: `changes requested by ${actor}`,
            actor,
            patch: { error: { class: "changes_requested", message: comment, previousHeadSha: t.headSha }, maxAttempts: Math.max(t.maxAttempts, t.attempt + 1), autoStart: true },
          }),
          integrate: false,
        };
      }
      if (!t.headSha || !t.branch) throw new DomainError("NOTHING_TO_INTEGRATE", "Task has no validated commit", 409);
      // Claim the integration (prevents concurrent double-merge).
      const [c] = await tx
        .update(tasks)
        .set({ leaseOwner: `integration:${a!.id}` })
        .where(and(eq(tasks.id, taskId), isNull(tasks.leaseOwner)))
        .returning();
      if (!c) throw conflict("Integration already claimed");
      return { task: c, integrate: true };
    });
    if (!claimed.integrate) return { task: claimed.task };
    return this.integrate(claimed.task, actor);
  }

  private async integrate(task: TaskRow, actor: string): Promise<{ task: TaskRow; integration: IntegrationResult }> {
    const { db, workspaces } = this.d;
    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId));
    if (!project) throw notFound("Project", task.projectId);
    const policy = ProjectPolicy.parse(project.policy);
    const claim = task.leaseOwner!;
    await publishEvent(db, { projectId: task.projectId, taskId: task.id, type: "integration.started", payload: { actor, headSha: task.headSha, target: project.defaultBranch } });
    let integration: IntegrationResult;
    try {
      integration = await workspaces.integrate({
        repo: project.repoPath,
        projectId: project.id,
        taskId: task.id,
        // Merge the exact validated commit, not the (mutable) branch name.
        branch: task.headSha!,
        target: project.defaultBranch,
        validate: async (dir) => {
          if (!policy.validationCommands.length) return { passed: true, detail: { commands: [] } };
          const common = gitCommonDir(dir);
          const gates = await runCommandGates({ dir, commands: policy.validationCommands, sandbox: this.d.sandbox, env: buildAgentEnv().env, timeoutMs: this.d.validationTimeoutMs, readOnly: common ? [common] : [] });
          for (const g of gates) await db.insert(validations).values({ taskId: task.id, stage: "integration", gate: g.gate, passed: g.passed, detail: g.detail });
          return { passed: gates.every((g) => g.passed), detail: gates };
        },
      });
    } catch (e) {
      integration = { ok: false, reason: "integration_validation_failed", detail: e instanceof Error ? e.message : String(e), targetSha: "" };
    }
    const final = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for("update");
      if (cur?.leaseOwner !== claim) throw conflict("Integration claim lost");
      if (integration.ok) {
        return transition(tx, task.id, "COMPLETED", {
          reason: `integrated into ${project.defaultBranch} at ${integration.mergeSha.slice(0, 12)}`,
          actor,
          patch: { leaseOwner: null, result: { ...(cur.result as object), mergeSha: integration.mergeSha, integratedInto: project.defaultBranch } },
        });
      }
      return transition(tx, task.id, "FAILED", {
        reason: `integration failed: ${integration.reason}`,
        actor,
        patch: { leaseOwner: null, error: { class: "integration_failed", reason: integration.reason, conflicts: integration.conflicts, detail: integration.detail } },
      });
    });
    await publishEvent(db, { projectId: task.projectId, taskId: task.id, type: integration.ok ? "integration.completed" : "integration.failed", payload: { ...integration, actor } });
    if (integration.ok && this.d.onIntegrated) {
      const changed = (await gitOut(project.repoPath, ["diff", "--name-only", integration.targetSha, integration.mergeSha]).catch(() => "")).split("\n").filter(Boolean);
      await this.d.onIntegrated({ projectId: project.id, taskId: task.id, changedPaths: changed, mergeSha: integration.mergeSha, targetSha: integration.targetSha }).catch(() => undefined);
    }
    if (integration.ok && task.worktreePath) await workspaces.removeIfExists(project.repoPath, task.worktreePath);
    return { task: final, integration };
  }
}
