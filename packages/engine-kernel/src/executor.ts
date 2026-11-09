import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { Plan, PLAN_JSON_SCHEMA, ProjectPolicy, RETRYABLE_ERRORS, type AgentEvent, type ExecutionResult, type TaskStatus } from "@agentmesh/contracts";
import { agents, artifacts, projects, runs, taskDependencies, tasks, validations, type Db, type Tx } from "@agentmesh/database";
import { buildAgentEnv, gitCommonDir, noSandbox, type AdapterRegistry, type Sandbox } from "@agentmesh/execution-runtime";
import { Redactor, type Logger } from "@agentmesh/observability";
import { runCommandGates, type GateResult } from "@agentmesh/validation-engine";
import { checkScope, collectChanges, commitAll, type WorkspaceManager } from "@agentmesh/workspace-manager";
import type { KnowledgeService } from "@agentmesh/shared-memory";
import type { ApprovalService } from "./approvals.ts";
import type { CollaborationService } from "./collaboration.ts";
import { compileContext } from "./context.ts";
import { publishEvent } from "./events.ts";
import { heartbeat, retryDelayMs } from "./scheduler.ts";
import { transition, type TaskRow, type TaskService } from "./tasks.ts";

export interface EngineConfig {
  dataDir: string;
  workerId: string;
  leaseMs: number;
  heartbeatMs: number;
  sandbox: Sandbox;
  validationTimeoutMs: number;
  /** Base delay for retry backoff. */
  retryBaseMs?: number;
  /** URL agents use to reach the AgentMesh API (collaboration tools). Unset = no tools. */
  apiUrl?: string;
  /** Path of the bundled MCP stdio server (packages/mcp-server). Unset = no MCP registration. */
  mcpBundle?: string;
}

export interface ExecutorDeps {
  db: Db;
  registry: AdapterRegistry;
  workspaces: WorkspaceManager;
  tasksService: TaskService;
  approvals: ApprovalService;
  config: EngineConfig;
  logger: Logger;
  knowledge: KnowledgeService;
  collaboration: CollaborationService;
}

type AbortReason = "lost" | "paused" | "shutdown";

const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "message"],
        properties: { severity: { type: "string", enum: ["info", "minor", "major", "critical"] }, file: { type: "string" }, message: { type: "string" } },
      },
    },
  },
} as const;

/**
 * Executes one leased task end-to-end: workspace -> context snapshot -> sandboxed agent
 * run -> quality gates -> COMPLETED / AWAITING_APPROVAL / RETRY_WAIT / FAILED.
 * A successful process exit is never treated as task completion by itself.
 */
export class TaskExecutor {
  constructor(private d: ExecutorDeps) {}

  async run(leased: TaskRow, shutdown: AbortSignal): Promise<void> {
    const { db, config, logger } = this.d;
    const workerId = config.workerId;
    const log = logger.child({ taskId: leased.id, attempt: leased.attempt });
    const [project] = await db.select().from(projects).where(eq(projects.id, leased.projectId));
    const [agent] = leased.assignedAgentId ? await db.select().from(agents).where(eq(agents.id, leased.assignedAgentId)) : [];
    if (!project || !agent) {
      await db.transaction((tx) => transition(tx, leased.id, "FAILED", { reason: "project or agent missing", actor: workerId, expectLeaseOwner: workerId, patch: { leaseOwner: null } }));
      return;
    }
    const policy = ProjectPolicy.parse(project.policy);

    // Idempotent run creation: one run per (task, attempt).
    const [run] = await db.insert(runs).values({ taskId: leased.id, agentId: agent.id, attempt: leased.attempt, workerId, status: "running" }).onConflictDoNothing().returning();
    if (!run) {
      // Should be impossible with CAS leasing; fail loudly rather than leave a dangling lease.
      log.error("run for this attempt already exists; refusing duplicate execution");
      await db
        .transaction((tx) => transition(tx, leased.id, "FAILED", { reason: `duplicate run for attempt ${leased.attempt}`, actor: workerId, expectLeaseOwner: workerId, patch: { leaseOwner: null, error: { class: "engine_error", message: "duplicate run for attempt" } } }))
        .catch(() => undefined);
      return;
    }
    let task: TaskRow;
    try {
      task = await db.transaction((tx) => transition(tx, leased.id, "RUNNING", { reason: `run ${run.id} started on ${agent.name}`, actor: workerId, expectFrom: ["LEASED"], expectLeaseOwner: workerId }));
    } catch (e) {
      await db.update(runs).set({ status: "cancelled", errorClass: "cancelled", errorMessage: String(e), finishedAt: new Date() }).where(eq(runs.id, run.id));
      return;
    }

    const redactor = new Redactor();
    const ac = new AbortController();
    let abortReason: AbortReason | null = null;
    const abort = (r: AbortReason) => {
      if (!abortReason) {
        abortReason = r;
        ac.abort();
      }
    };
    const onShutdown = () => abort("shutdown");
    shutdown.addEventListener("abort", onShutdown, { once: true });
    const hb = setInterval(() => {
      heartbeat(db, task.id, workerId, config.leaseMs)
        .then((o) => {
          if (o !== "ok") abort(o);
        })
        .catch((e) => log.error({ err: e }, "heartbeat failed"));
    }, config.heartbeatMs);

    let sessionId: string | null = null;
    let eventChain: Promise<unknown> = Promise.resolve();
    const emit = (type: string, payload: Record<string, unknown>) => {
      eventChain = eventChain
        .then(() => publishEvent(db, { projectId: task.projectId, taskId: task.id, runId: run.id, type, payload: redactor.redactDeep(payload) }))
        .catch((e) => log.error({ err: e }, "event publish failed"));
    };

    try {
      // ---------- workspace
      const baseRef = await this.baseRefFor(task, project.defaultBranch);
      const wt = await this.d.workspaces.create({ repo: project.repoPath, projectId: project.id, taskId: task.id, attempt: task.attempt, baseRef, withBranch: task.modifiesCode });
      await db.update(tasks).set({ branch: wt.branch, baseSha: wt.baseSha, worktreePath: wt.path, headSha: null }).where(eq(tasks.id, task.id));
      emit("run.workspace", { path: wt.path, branch: wt.branch, baseSha: wt.baseSha, baseRef });

      // ---------- context
      const outputSchema = task.kind === "plan" ? PLAN_JSON_SCHEMA : task.kind === "review" ? REVIEW_JSON_SCHEMA : undefined;
      // Run-scoped credential for collaboration tools (revoked in finally).
      let session: { token: string; sessionId: string } | null = null;
      if (config.apiUrl) {
        session = await this.d.collaboration.issueSession({ id: run.id, taskId: task.id, agentId: agent.id }, task.projectId, task.timeoutMs + 15 * 60_000);
        sessionId = session.sessionId;
        redactor.addSecret(session.token);
      }
      const toolsNote = session
        ? "\nCollaboration: AgentMesh tools are available (MCP server `agentmesh`). Publish important discoveries with knowledge.publish (include evidence), check shared knowledge with knowledge.search, and use agent.requestReview / agent.requestHelp / task.propose instead of doing out-of-scope work yourself."
        : "";
      const snapshot = await compileContext(db, task, {
        knowledge: { service: this.d.knowledge, agentId: agent.id, runId: run.id },
        sourceCommitSha: wt.baseSha,
        tokenBudget: policy.contextTokenBudget,
        previousFailure: task.attempt > 1 ? task.error : undefined,
        extraInstructions:
          task.kind === "plan"
            ? `Decompose the goal into a dependency-ordered set of tasks. Return them as structured output. Use \`dependsOn\` with other task keys. Do not implement anything.${toolsNote}`
            : task.kind === "review"
              ? `Review the changes from the upstream task(s) (see dependency outputs; the working tree contains them). Return a verdict and concrete findings.${toolsNote}`
              : toolsNote.trim() || undefined,
      });
      await db.update(runs).set({ contextSnapshotId: snapshot.id }).where(eq(runs.id, run.id));
      emit("run.context", { snapshotId: snapshot.id, sha256: snapshot.sha256, tokenEstimate: snapshot.tokenEstimate });

      // ---------- agent execution
      const perms = agent.permissions as { sandbox?: boolean; secretEnv?: string[] };
      const toolEnv: Record<string, string> = session && config.apiUrl ? { AGENTMESH_API_URL: config.apiUrl, AGENTMESH_AGENT_TOKEN: session.token } : {};
      const env = buildAgentEnv({ secretEnv: perms.secretEnv ?? [], extra: toolEnv });
      env.secretValues.forEach((s) => redactor.addSecret(s));
      if (env.missingSecrets.length) emit("run.warning", { message: `secret env vars not set on worker: ${env.missingSecrets.join(", ")}` });
      const scratchDir = path.join(config.dataDir, "scratch", run.id);
      await mkdir(scratchDir, { recursive: true, mode: 0o700 });
      // The MCP server reads the run token from a 0600 file so it never appears in process argv.
      const tokenFile = path.join(scratchDir, "agentmesh-token");
      if (session) await writeFile(tokenFile, session.token, { mode: 0o600 });
      const sandbox = perms.sandbox === false ? noSandbox : config.sandbox;
      const common = gitCommonDir(wt.path);
      const adapter = this.d.registry.create(agent);
      const onEvent = (e: AgentEvent) => emit(e.type, { message: e.message, ...(e.data ? { data: e.data } : {}) });

      let result: ExecutionResult;
      try {
        if (ac.signal.aborted) throw new Error("aborted before agent start");
        result = await adapter.execute(
          {
            runId: run.id,
            taskId: task.id,
            workdir: wt.path,
            prompt: snapshot.rendered,
            sandbox: task.modifiesCode ? "workspace-write" : "read-only",
            timeoutMs: task.timeoutMs,
            outputSchema: outputSchema as Record<string, unknown> | undefined,
            config: agent.config,
            env: env.env,
            scratchDir,
            wrapCommand: (cmd, args, o) =>
              sandbox.wrap(cmd, args, {
                workdir: wt.path,
                writable: task.modifiesCode,
                network: true,
                readOnly: [...(common ? [common] : []), ...(session && config.mcpBundle ? [path.dirname(process.execPath), config.mcpBundle] : []), ...(o.readOnly ?? [])],
                readWrite: [scratchDir, ...(o.readWrite ?? [])],
              }),
            onEvent,
            ...(session && config.mcpBundle && config.apiUrl
              ? { mcp: { name: "agentmesh", command: process.execPath, args: [config.mcpBundle, "--api-url", config.apiUrl, "--token-file", tokenFile], env: {} } }
              : {}),
          },
          ac.signal,
        );
      } catch (e) {
        result = { status: "failed", exitCode: null, summary: "", errorClass: "provider_error", errorMessage: e instanceof Error ? e.message : String(e), usage: {} };
      }
      await eventChain;
      await rm(scratchDir, { recursive: true, force: true });

      await db
        .update(runs)
        .set({
          status: abortReason ? "cancelled" : result.status,
          exitCode: result.exitCode,
          summary: redactor.redact(result.summary).slice(0, 100_000),
          structuredOutput: redactor.redactDeep(result.structuredOutput ?? null),
          errorClass: abortReason ? `aborted:${abortReason}` : (result.errorClass ?? null),
          errorMessage: result.errorMessage ? redactor.redact(result.errorMessage).slice(0, 10_000) : null,
          usage: result.usage as Record<string, number>,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, run.id));
      emit("run.finished", { status: result.status, exitCode: result.exitCode, errorClass: result.errorClass, usage: result.usage });

      if (abortReason) return await this.handleAbort(task, abortReason);
      if (result.status !== "succeeded") {
        const retryable = !!result.errorClass && RETRYABLE_ERRORS.includes(result.errorClass);
        return await this.fail(task, "RUNNING", { class: result.errorClass ?? "provider_error", message: redactor.redact(result.errorMessage ?? "agent run failed") }, retryable);
      }

      await db.transaction((tx) => transition(tx, task.id, "VALIDATING", { reason: "agent run succeeded; running quality gates", actor: workerId, expectFrom: ["RUNNING"], expectLeaseOwner: workerId }));

      // ---------- quality gates
      const gates: GateResult[] = [{ gate: "agent_result", passed: true, detail: { status: result.status } }];
      const changes = await collectChanges(wt.path, wt.baseSha);
      await this.artifact(task.id, run.id, "changed-files", "changed-files.json", JSON.stringify(changes.files, null, 2));
      if (changes.diff) await this.artifact(task.id, run.id, "diff", "changes.diff", redactor.redact(changes.diff).slice(0, 2_000_000));

      if (!task.modifiesCode) {
        gates.push({ gate: "read_only", passed: changes.files.length === 0, detail: { changedFiles: changes.files } });
      } else {
        const violations = await checkScope(wt.path, changes.files, task.allowedPaths, policy.protectedPaths);
        gates.push({ gate: "file_scope", passed: violations.length === 0, detail: { violations, allowed: task.allowedPaths } });
      }
      if (task.kind === "plan") {
        const p = Plan.safeParse(result.structuredOutput);
        gates.push({ gate: "plan_schema", passed: p.success, detail: p.success ? { tasks: p.data.tasks.length } : { issues: p.error.issues.slice(0, 20) } });
      }
      let headSha: string | null = null;
      if (gates.every((g) => g.passed) && task.modifiesCode && changes.files.length) {
        headSha = await commitAll(wt.path, `AgentMesh: ${task.title}\n\nTask: ${task.id}\nRun: ${run.id}\nAgent: ${agent.name}`);
        if (policy.validationCommands.length) {
          const cmdGates = await runCommandGates({
            dir: wt.path,
            commands: policy.validationCommands,
            sandbox: config.sandbox,
            env: buildAgentEnv().env,
            timeoutMs: config.validationTimeoutMs,
            readOnly: common ? [common] : [],
            signal: ac.signal,
          });
          gates.push(...cmdGates);
          for (const g of cmdGates) await this.artifact(task.id, run.id, "test-report", g.gate.slice(0, 200), redactor.redact(JSON.stringify(g.detail, null, 2)));
        }
      }
      for (const g of gates) {
        await db.insert(validations).values({ taskId: task.id, runId: run.id, stage: "run", gate: g.gate, passed: g.passed, detail: redactor.redactDeep(g.detail) });
        emit("validation.gate", { gate: g.gate, passed: g.passed });
      }
      if (abortReason) return await this.handleAbort(task, abortReason);

      const failed = gates.filter((g) => !g.passed);
      if (failed.length) {
        return await this.fail(task, "VALIDATING", { class: "quality_gate", message: `Quality gates failed: ${failed.map((g) => g.gate).join(", ")}`, gates: failed.map((g) => ({ gate: g.gate, detail: g.detail })) }, true);
      }

      // ---------- outcome
      const resultDoc = { summary: redactor.redact(result.summary).slice(0, 20_000), structuredOutput: result.structuredOutput ?? null, changedFiles: changes.files, headSha, usage: result.usage };
      // Any task with commits goes through AWAITING_APPROVAL: the single integration path.
      const needsApproval = task.modifiesCode && headSha !== null;
      await db.transaction(async (tx) => {
        const to: TaskStatus = needsApproval ? "AWAITING_APPROVAL" : "COMPLETED";
        await transition(tx, task.id, to, {
          reason: needsApproval ? (task.requiresApproval ? "validated; awaiting human approval for integration" : "validated; integrating per policy") : "validated",
          actor: workerId,
          expectFrom: ["VALIDATING"],
          expectLeaseOwner: workerId,
          patch: { leaseOwner: null, leaseExpiresAt: null, headSha, result: resultDoc, error: null },
        });
        if (task.kind === "plan") {
          const children = await this.d.tasksService.createFromPlan(tx, task, result.structuredOutput, policy.autoStartPlannedTasks);
          await publishEvent(tx, { projectId: task.projectId, taskId: task.id, type: "plan.materialized", payload: { childTaskIds: children.map((c) => c.id) } });
        }
      });
      if (needsApproval && !task.requiresApproval) {
        // Project policy waives human approval; integration still validates the merge result.
        await this.d.approvals.decide(task.id, "approved", "approval not required by project policy", "policy:auto-approve");
      }
      if (!task.modifiesCode || headSha === null) await this.d.workspaces.removeIfExists(project.repoPath, wt.path);
    } catch (e) {
      log.error({ err: e }, "execution error");
      emit("run.error", { message: e instanceof Error ? e.message : String(e) });
      await eventChain;
      await db.update(runs).set({ status: "failed", errorClass: "engine_error", errorMessage: String(e).slice(0, 2000), finishedAt: new Date() }).where(and(eq(runs.id, run.id), eq(runs.status, "running")));
      const [cur] = await db.select().from(tasks).where(eq(tasks.id, task.id));
      if (cur && ["RUNNING", "VALIDATING"].includes(cur.status) && cur.leaseOwner === workerId) {
        await this.fail(cur, cur.status as "RUNNING" | "VALIDATING", { class: "engine_error", message: e instanceof Error ? e.message : String(e) }, true).catch(() => undefined);
      }
    } finally {
      if (sessionId) await this.d.collaboration.revokeSession(sessionId).catch((e) => log.error({ err: e }, "session revoke failed"));
      clearInterval(hb);
      shutdown.removeEventListener("abort", onShutdown);
      await eventChain;
    }
  }

  /**
   * Read-only tasks that depend on exactly one validated-but-unintegrated upstream task are
   * checked out at that task's head, so reviewers see the actual changes.
   */
  private async baseRefFor(task: TaskRow, defaultBranch: string): Promise<string> {
    if (task.modifiesCode) return defaultBranch;
    const deps = await this.d.db
      .select({ status: tasks.status, headSha: tasks.headSha })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(eq(taskDependencies.taskId, task.id));
    const pending = deps.filter((d) => d.status === "AWAITING_APPROVAL" && d.headSha);
    return pending.length === 1 ? pending[0]!.headSha! : defaultBranch;
  }

  private async handleAbort(task: TaskRow, reason: AbortReason): Promise<void> {
    const { db, config } = this.d;
    if (reason === "lost") return; // cancelled or reclaimed: the new owner/state wins
    await db
      .transaction((tx) =>
        transition(tx, task.id, reason === "paused" ? "READY" : "RETRY_WAIT", {
          reason: reason === "paused" ? "paused by user; run aborted" : "worker shutting down; run aborted",
          actor: config.workerId,
          expectLeaseOwner: config.workerId,
          // Aborts caused by pause/shutdown do not consume the attempt budget. Attempt numbers
          // stay monotonic (one run per attempt); the budget is extended instead.
          patch: { leaseOwner: null, leaseExpiresAt: null, maxAttempts: task.maxAttempts + 1, nextRetryAt: new Date() },
        }),
      )
      .catch(() => undefined);
  }

  private async fail(task: TaskRow, from: "RUNNING" | "VALIDATING", error: Record<string, unknown>, retryable: boolean): Promise<void> {
    const { db, config } = this.d;
    const exhausted = !retryable || task.attempt >= task.maxAttempts;
    await db.transaction((tx: Tx) =>
      transition(tx, task.id, exhausted ? "FAILED" : "RETRY_WAIT", {
        reason: `${String(error.class)}: ${String(error.message)}`.slice(0, 500),
        actor: config.workerId,
        expectFrom: [from],
        expectLeaseOwner: config.workerId,
        patch: { leaseOwner: null, leaseExpiresAt: null, error: { ...error, attempt: task.attempt }, nextRetryAt: exhausted ? null : new Date(Date.now() + retryDelayMs(task.attempt, config.retryBaseMs)) },
      }),
    );
  }

  private async artifact(taskId: string, runId: string, kind: "diff" | "changed-files" | "test-report" | "log", name: string, content: string) {
    await this.d.db.insert(artifacts).values({ taskId, runId, kind, name, content, sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content) });
  }
}

