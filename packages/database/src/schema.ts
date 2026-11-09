import { sql, type SQL } from "drizzle-orm";
import {
  bigserial,
  customType,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
/** Dimensions of knowledge embeddings (see packages/shared-memory/src/embedding.ts). */
export const EMBEDDING_DIMS = 256;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();
const updated = () => ts("updated_at").notNull().defaultNow();

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** sha256 hex of the bearer token; plaintext is shown once at creation. */
  tokenHash: text("token_hash").notNull().unique(),
  role: text("role").notNull().$type<"admin" | "operator" | "viewer">(),
  /** null = all projects. */
  projectIds: jsonb("project_ids").$type<string[] | null>(),
  createdAt: created(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull().unique(),
  defaultBranch: text("default_branch").notNull(),
  instructions: text("instructions").notNull().default(""),
  policy: jsonb("policy").notNull().$type<Record<string, unknown>>(),
  createdAt: created(),
  updatedAt: updated(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  maxConcurrency: integer("max_concurrency").notNull().default(1),
  config: jsonb("config").notNull().$type<Record<string, unknown>>().default({}),
  permissions: jsonb("permissions").notNull().$type<Record<string, unknown>>().default({}),
  /** Manual override; null = use discovered capabilities. */
  capabilityOverride: jsonb("capability_override").$type<string[] | null>(),
  discoveredCapabilities: jsonb("discovered_capabilities").notNull().$type<string[]>().default([]),
  health: text("health").notNull().default("unknown").$type<"unknown" | "healthy" | "unavailable">(),
  integrationMode: text("integration_mode").notNull().default("unavailable").$type<"automated" | "assisted" | "unavailable">(),
  version: text("version"),
  probeDetail: text("probe_detail").notNull().default(""),
  lastProbeAt: ts("last_probe_at"),
  createdAt: created(),
  updatedAt: updated(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    parentTaskId: uuid("parent_task_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    acceptanceCriteria: jsonb("acceptance_criteria").notNull().$type<string[]>().default([]),
    kind: text("kind").notNull().$type<"plan" | "implement" | "review" | "test" | "generic">(),
    requiredCapabilities: jsonb("required_capabilities").notNull().$type<string[]>().default([]),
    status: text("status").notNull().default("PENDING"),
    paused: boolean("paused").notNull().default(false),
    autoStart: boolean("auto_start").notNull().default(false),
    priority: integer("priority").notNull().default(50),
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),
    assignmentMode: text("assignment_mode").notNull().default("auto").$type<"manual" | "auto">(),
    allowedPaths: jsonb("allowed_paths").notNull().$type<string[]>().default([]),
    modifiesCode: boolean("modifies_code").notNull().default(true),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    timeoutMs: integer("timeout_ms").notNull().default(1_800_000),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    collaborationDepth: integer("collaboration_depth").notNull().default(0),
    /** How the task came to exist. Agent-originated tasks are traceable to the requesting task. */
    origin: text("origin").notNull().default("user").$type<"user" | "plan" | "workflow" | "help_request" | "review_request" | "proposal">(),
    requestedByTaskId: uuid("requested_by_task_id"),
    workflowRunId: uuid("workflow_run_id"),
    workflowNodeId: text("workflow_node_id"),
    idempotencyKey: text("idempotency_key"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: ts("lease_expires_at"),
    heartbeatAt: ts("heartbeat_at"),
    nextRetryAt: ts("next_retry_at"),
    branch: text("branch"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    worktreePath: text("worktree_path"),
    result: jsonb("result"),
    error: jsonb("error"),
    version: integer("version").notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("tasks_status_idx").on(t.status, t.priority),
    index("tasks_project_idx").on(t.projectId),
    uniqueIndex("tasks_idempotency_idx").on(t.projectId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    /** success: upstream must complete. failure: run only if upstream failed. always: run once upstream settles. */
    condition: text("condition").notNull().default("success").$type<"success" | "failure" | "always">(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }), index("deps_rev_idx").on(t.dependsOnTaskId)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    attempt: integer("attempt").notNull(),
    workerId: text("worker_id").notNull(),
    status: text("status").notNull().$type<"running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "abandoned">(),
    exitCode: integer("exit_code"),
    errorClass: text("error_class"),
    errorMessage: text("error_message"),
    summary: text("summary"),
    structuredOutput: jsonb("structured_output"),
    usage: jsonb("usage").notNull().$type<Record<string, number>>().default({}),
    contextSnapshotId: uuid("context_snapshot_id"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  // One run per (task, attempt): makes run creation idempotent under duplicate leases.
  (t) => [uniqueIndex("runs_task_attempt_idx").on(t.taskId, t.attempt), index("runs_agent_idx").on(t.agentId)],
);

export const contextSnapshots = pgTable("context_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  sha256: text("sha256").notNull(),
  sourceCommitSha: text("source_commit_sha"),
  tokenEstimate: integer("token_estimate").notNull(),
  tokenBudget: integer("token_budget").notNull(),
  sections: jsonb("sections").notNull().$type<{ title: string; source: string; content: string; truncated: boolean }[]>(),
  rendered: text("rendered").notNull(),
  createdAt: created(),
});

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id"),
    taskId: uuid("task_id"),
    runId: uuid("run_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>().default({}),
    createdAt: created(),
  },
  (t) => [index("events_task_idx").on(t.taskId, t.id), index("events_project_idx").on(t.projectId, t.id)],
);

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().$type<"diff" | "log" | "test-report" | "changed-files" | "file" | "screenshot">(),
  name: text("name").notNull(),
  content: text("content").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: created(),
});

export const validations = pgTable("validations", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  /** "run-integration" validations are executed on the merge result. */
  stage: text("stage").notNull().$type<"run" | "integration">(),
  gate: text("gate").notNull(),
  passed: boolean("passed").notNull(),
  detail: jsonb("detail").notNull().$type<Record<string, unknown>>().default({}),
  createdAt: created(),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  decision: text("decision").notNull().$type<"approved" | "rejected" | "changes_requested">(),
  actor: text("actor").notNull(),
  comment: text("comment").notNull().default(""),
  headSha: text("head_sha"),
  createdAt: created(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    detail: jsonb("detail").notNull().$type<Record<string, unknown>>().default({}),
    createdAt: created(),
  },
  (t) => [index("audit_target_idx").on(t.targetType, t.targetId)],
);

// ---------------------------------------------------------------- shared knowledge fabric

export type KnowledgeStatus = "proposed" | "evidenced" | "verified" | "accepted" | "disputed" | "rejected" | "superseded" | "stale";

export const knowledgeRecords = pgTable(
  "knowledge_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    /** One repository per project today; kept separate so multi-repo projects need no contract change. */
    repositoryId: uuid("repository_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    statement: text("statement").notNull(),
    status: text("status").notNull().default("proposed").$type<KnowledgeStatus>(),
    /** project: relevant project-wide. paths: relevant when touching affectedPaths. task: only for the source task's subtree. */
    scope: text("scope").notNull().default("project").$type<"project" | "paths" | "task">(),
    /** null = every agent working on the project may read it; otherwise only these agent ids. */
    allowedAgentIds: jsonb("allowed_agent_ids").$type<string[] | null>(),
    confidence: integer("confidence").notNull().default(50),
    tags: jsonb("tags").notNull().$type<string[]>().default([]),
    sourceAgentId: uuid("source_agent_id"),
    sourceRunId: uuid("source_run_id"),
    sourceTaskId: uuid("source_task_id"),
    /** "agent:<id>" or "user:<name>" */
    sourceActor: text("source_actor").notNull(),
    sourceCommitSha: text("source_commit_sha"),
    affectedPaths: jsonb("affected_paths").notNull().$type<string[]>().default([]),
    fingerprint: text("fingerprint").notNull(),
    supersededById: uuid("superseded_by_id"),
    verifiedBy: text("verified_by"),
    verifiedAt: ts("verified_at"),
    statusReason: text("status_reason").notNull().default(""),
    version: integer("version").notNull().default(1),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }),
    search: tsvector("search").generatedAlwaysAs(
      (): SQL => sql`setweight(to_tsvector('english', coalesce(${knowledgeRecords.title}, '')), 'A') || setweight(to_tsvector('english', coalesce(${knowledgeRecords.statement}, '')), 'B')`,
    ),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("knowledge_project_idx").on(t.projectId, t.status),
    index("knowledge_fingerprint_idx").on(t.projectId, t.fingerprint),
    index("knowledge_search_idx").using("gin", t.search),
  ],
);

export const knowledgeEvidence = pgTable(
  "knowledge_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeId: uuid("knowledge_id").notNull().references(() => knowledgeRecords.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<"run" | "artifact" | "validation" | "file" | "test" | "commit" | "note">(),
    /** Reference to the evidence: run id, artifact id, validation id, "path:line", commit sha. */
    reference: text("reference").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    addedBy: text("added_by").notNull(),
    commitSha: text("commit_sha"),
    createdAt: created(),
  },
  (t) => [index("evidence_knowledge_idx").on(t.knowledgeId)],
);

export const knowledgeRelations = pgTable(
  "knowledge_relations",
  {
    fromId: uuid("from_id").notNull().references(() => knowledgeRecords.id, { onDelete: "cascade" }),
    toId: uuid("to_id").notNull().references(() => knowledgeRecords.id, { onDelete: "cascade" }),
    relation: text("relation").notNull().$type<"duplicates" | "supports" | "contradicts" | "supersedes" | "relates_to" | "derived_from">(),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.fromId, t.toId, t.relation] }), index("relations_to_idx").on(t.toId)],
);

/** Which task/run/agent received a record in a context snapshot or a search result. */
export const knowledgeConsumption = pgTable(
  "knowledge_consumption",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    knowledgeId: uuid("knowledge_id").notNull().references(() => knowledgeRecords.id, { onDelete: "cascade" }),
    knowledgeVersion: integer("knowledge_version").notNull(),
    taskId: uuid("task_id"),
    runId: uuid("run_id"),
    agentId: uuid("agent_id"),
    contextSnapshotId: uuid("context_snapshot_id"),
    via: text("via").notNull().$type<"context" | "search" | "get" | "refresh">(),
    createdAt: created(),
  },
  (t) => [index("consumption_knowledge_idx").on(t.knowledgeId), index("consumption_task_idx").on(t.taskId)],
);

export const knowledgeSubscriptions = pgTable(
  "knowledge_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    types: jsonb("types").notNull().$type<string[]>().default([]),
    paths: jsonb("paths").notNull().$type<string[]>().default([]),
    query: text("query").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
  },
  (t) => [index("subscriptions_project_idx").on(t.projectId)],
);

// ---------------------------------------------------------------- agent sessions (run-scoped credentials)

/** Short-lived credential handed to one agent run for MCP / agent-tool calls. Revoked when the run ends. */
export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  /** Number of agent-originated tasks this session has created (bounded). */
  requestsMade: integer("requests_made").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  createdAt: created(),
});

// ---------------------------------------------------------------- workflows

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** null = global template */
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isTemplate: boolean("is_template").notNull().default(false),
  graph: jsonb("graph").notNull().$type<Record<string, unknown>>(),
  version: integer("version").notNull().default(1),
  createdAt: created(),
  updatedAt: updated(),
});

export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  workflowVersion: integer("workflow_version").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  input: jsonb("input").notNull().$type<Record<string, unknown>>(),
  /** workflow node id -> task id */
  nodeTasks: jsonb("node_tasks").notNull().$type<Record<string, string>>(),
  createdBy: text("created_by").notNull(),
  createdAt: created(),
});
