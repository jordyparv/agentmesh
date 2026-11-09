import type { Agent, Project, Task } from "@agentmesh/contracts";
import { ProjectPolicy, AgentPermissions } from "@agentmesh/contracts";
import type { agents, projects } from "@agentmesh/database";
import { effectiveCapabilities } from "./router.ts";
import type { TaskRow } from "./tasks.ts";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toProject(p: typeof projects.$inferSelect): Project {
  return { id: p.id, name: p.name, repoPath: p.repoPath, defaultBranch: p.defaultBranch, instructions: p.instructions, policy: ProjectPolicy.parse(p.policy), createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() };
}

export function toAgent(a: typeof agents.$inferSelect, activeRuns?: number): Agent {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    enabled: a.enabled,
    maxConcurrency: a.maxConcurrency,
    config: a.config,
    permissions: AgentPermissions.parse(a.permissions),
    capabilities: effectiveCapabilities(a),
    health: a.health,
    integrationMode: a.integrationMode,
    version: a.version,
    probeDetail: a.probeDetail,
    lastProbeAt: iso(a.lastProbeAt),
    ...(activeRuns !== undefined ? { activeRuns } : {}),
    createdAt: a.createdAt.toISOString(),
  };
}

export function toTask(t: TaskRow, dependsOn: string[]): Task {
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    description: t.description,
    acceptanceCriteria: t.acceptanceCriteria,
    kind: t.kind,
    requiredCapabilities: t.requiredCapabilities,
    status: t.status as Task["status"],
    paused: t.paused,
    autoStart: t.autoStart,
    priority: t.priority,
    assignedAgentId: t.assignedAgentId,
    assignmentMode: t.assignmentMode,
    allowedPaths: t.allowedPaths,
    modifiesCode: t.modifiesCode,
    requiresApproval: t.requiresApproval,
    timeoutMs: t.timeoutMs,
    attempt: t.attempt,
    maxAttempts: t.maxAttempts,
    branch: t.branch,
    baseSha: t.baseSha,
    headSha: t.headSha,
    worktreePath: t.worktreePath,
    result: t.result ?? null,
    error: t.error ?? null,
    dependsOn,
    origin: t.origin,
    parentTaskId: t.parentTaskId,
    requestedByTaskId: t.requestedByTaskId,
    collaborationDepth: t.collaborationDepth,
    workflowRunId: t.workflowRunId,
    workflowNodeId: t.workflowNodeId,
    leaseOwner: t.leaseOwner,
    leaseExpiresAt: iso(t.leaseExpiresAt),
    nextRetryAt: iso(t.nextRetryAt),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
