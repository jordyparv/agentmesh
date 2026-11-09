import { z } from "zod";
import { CAPABILITIES } from "./adapter.ts";
import { TASK_STATUSES } from "./task-state.ts";

export const Id = z.uuid();

// ---------- Projects ----------
export const ProjectPolicy = z.object({
  /** Code-modifying tasks must be approved by a human before integration. */
  requireApproval: z.boolean().default(true),
  /** Shell commands run (sandboxed, no network) in the worktree as quality gates. */
  validationCommands: z.array(z.string().min(1).max(500)).max(20).default([]),
  /** Default file scope (globs, repo-relative) for code-modifying tasks. */
  defaultAllowedPaths: z.array(z.string().min(1).max(300)).max(100).default(["**"]),
  /** Paths no task may ever modify. */
  protectedPaths: z.array(z.string().min(1).max(300)).max(100).default([".git/**", ".github/workflows/**"]),
  defaultTimeoutMs: z.number().int().min(10_000).max(4 * 3600_000).default(30 * 60_000),
  maxAttempts: z.number().int().min(1).max(10).default(2),
  /** Tasks proposed by a planning agent are queued automatically (otherwise they wait in backlog for a human). */
  autoStartPlannedTasks: z.boolean().default(false),
  /** Context compiler token budget per task. */
  contextTokenBudget: z.number().int().min(1000).max(200_000).default(24_000),
});
export type ProjectPolicy = z.infer<typeof ProjectPolicy>;

export const CreateProject = z.object({
  name: z.string().trim().min(1).max(120),
  repoPath: z.string().min(1).max(1000),
  defaultBranch: z.string().min(1).max(200).optional(),
  instructions: z.string().max(50_000).default(""),
  policy: ProjectPolicy.partial().default({}),
});
export const UpdateProject = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  instructions: z.string().max(50_000).optional(),
  policy: ProjectPolicy.partial().optional(),
});

export const Project = z.object({
  id: Id,
  name: z.string(),
  repoPath: z.string(),
  defaultBranch: z.string(),
  instructions: z.string(),
  policy: ProjectPolicy,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof Project>;

// ---------- Agents ----------
export const AgentPermissions = z.object({
  /** Whether the agent may modify files at all. */
  allowWrite: z.boolean().default(true),
  /** Run the agent process inside the OS sandbox (bwrap). Disabling requires admin. */
  sandbox: z.boolean().default(true),
  /** Names of environment variables (resolved on the worker host) exposed to this agent. Values are never stored. */
  secretEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).max(20).default([]),
});
export type AgentPermissions = z.infer<typeof AgentPermissions>;

export const CreateAgent = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.string().min(1).max(40),
  enabled: z.boolean().default(true),
  maxConcurrency: z.number().int().min(1).max(32).default(1),
  /** Non-secret provider config, e.g. { model: "..." }. */
  config: z.record(z.string(), z.unknown()).default({}),
  permissions: AgentPermissions.partial().default({}),
  /** Optional manual capability override; otherwise discovered by probe. */
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
});
export const UpdateAgent = CreateAgent.partial().omit({ kind: true });

export const Agent = z.object({
  id: Id,
  name: z.string(),
  kind: z.string(),
  enabled: z.boolean(),
  maxConcurrency: z.number(),
  config: z.record(z.string(), z.unknown()),
  permissions: AgentPermissions,
  capabilities: z.array(z.string()),
  health: z.enum(["unknown", "healthy", "unavailable"]),
  integrationMode: z.enum(["automated", "assisted", "unavailable"]),
  version: z.string().nullable(),
  probeDetail: z.string(),
  lastProbeAt: z.string().nullable(),
  activeRuns: z.number().optional(),
  createdAt: z.string(),
});
export type Agent = z.infer<typeof Agent>;

// ---------- Tasks ----------
export const TaskKind = z.enum(["plan", "implement", "review", "test", "generic"]);
export type TaskKind = z.infer<typeof TaskKind>;
export const TaskStatusSchema = z.enum(TASK_STATUSES);

export const CreateTask = z.object({
  projectId: Id,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(50_000).default(""),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(50).default([]),
  kind: TaskKind.default("implement"),
  requiredCapabilities: z.array(z.enum(CAPABILITIES)).max(10).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  /** Manual assignment; omitted = capability-based automatic routing. */
  assignedAgentId: Id.nullable().optional(),
  dependsOn: z.array(Id).max(100).default([]),
  /** Repo-relative globs this task may modify. Defaults to project policy. */
  allowedPaths: z.array(z.string().min(1).max(300)).max(100).optional(),
  requiresApproval: z.boolean().optional(),
  timeoutMs: z.number().int().min(5_000).max(4 * 3600_000).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  /** Start immediately when dependencies are met (otherwise stays in backlog until started). */
  autoStart: z.boolean().default(false),
});
export type CreateTask = z.infer<typeof CreateTask>;

export const UpdateTask = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(50_000).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(50).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  assignedAgentId: Id.nullable().optional(),
  requiredCapabilities: z.array(z.enum(CAPABILITIES)).max(10).optional(),
  allowedPaths: z.array(z.string().min(1).max(300)).max(100).optional(),
  dependsOn: z.array(Id).max(100).optional(),
});

export const Task = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  kind: TaskKind,
  requiredCapabilities: z.array(z.string()),
  status: TaskStatusSchema,
  paused: z.boolean(),
  autoStart: z.boolean(),
  priority: z.number(),
  assignedAgentId: Id.nullable(),
  assignmentMode: z.enum(["manual", "auto"]),
  allowedPaths: z.array(z.string()),
  modifiesCode: z.boolean(),
  requiresApproval: z.boolean(),
  timeoutMs: z.number(),
  attempt: z.number(),
  maxAttempts: z.number(),
  branch: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  worktreePath: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z.unknown().nullable(),
  dependsOn: z.array(Id),
  origin: z.enum(["user", "plan", "workflow", "help_request", "review_request", "proposal"]),
  parentTaskId: Id.nullable(),
  requestedByTaskId: Id.nullable(),
  collaborationDepth: z.number(),
  workflowRunId: Id.nullable(),
  workflowNodeId: z.string().nullable(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const TaskAction = z.enum(["start", "pause", "resume", "cancel", "retry"]);
export type TaskAction = z.infer<typeof TaskAction>;

export const ApprovalDecision = z.enum(["approved", "rejected", "changes_requested"]);
export const CreateApproval = z.object({
  decision: ApprovalDecision,
  comment: z.string().max(10_000).default(""),
});

// ---------- Plans (planner output -> DAG) ----------
export const PlannedTask = z.object({
  key: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(""),
  kind: TaskKind.default("implement"),
  requiredCapabilities: z.array(z.enum(CAPABILITIES)).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).default([]),
});
export const Plan = z.object({ tasks: z.array(PlannedTask).min(1).max(50) });
export type Plan = z.infer<typeof Plan>;

/** JSON Schema handed to planning agents for structured output. Kept in sync with Plan. */
export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "description", "kind", "requiredCapabilities", "acceptanceCriteria", "dependsOn"],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          kind: { type: "string", enum: ["implement", "review", "test", "generic"] },
          requiredCapabilities: { type: "array", items: { type: "string", enum: [...CAPABILITIES] } },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

// ---------- Events ----------
export const EngineEvent = z.object({
  id: z.number(),
  projectId: Id.nullable(),
  taskId: Id.nullable(),
  runId: Id.nullable(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type EngineEvent = z.infer<typeof EngineEvent>;

// ---------- Errors ----------
export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export const Role = z.enum(["admin", "operator", "viewer"]);
export type Role = z.infer<typeof Role>;
