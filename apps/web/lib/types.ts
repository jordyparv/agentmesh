import type { Agent, EngineEvent, KnowledgeRecord, Project, Task, TaskStatus, WorkflowGraph } from "@agentmesh/contracts";
export type { Agent, EngineEvent, KnowledgeRecord, Project, Task, TaskStatus, WorkflowGraph };

export interface TaskDetail extends Task {
  agent: { id: string; name: string; kind: string } | null;
  dependencies: { id: string; title: string; status: TaskStatus; kind: string }[];
  children: { id: string; title: string; status: TaskStatus; kind: string; origin: string }[];
}

export interface Run {
  id: string;
  taskId: string;
  agentId: string;
  attempt: number;
  workerId: string;
  status: string;
  exitCode: number | null;
  errorClass: string | null;
  errorMessage: string | null;
  summary: string | null;
  structuredOutput: unknown;
  usage: Record<string, number>;
  contextSnapshotId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Validation {
  id: string;
  taskId: string;
  runId: string | null;
  stage: "run" | "integration";
  gate: string;
  passed: boolean;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ArtifactMeta {
  id: string;
  runId: string | null;
  kind: string;
  name: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface SearchHit {
  record: KnowledgeRecord;
  score: number | null;
  signals: Record<string, number> | null;
  authoritative: boolean;
}

export interface KnowledgeDetail {
  record: KnowledgeRecord;
  authoritative: boolean;
  evidence: { id: string; kind: string; reference: string; excerpt: string; addedBy: string; commitSha: string | null; createdAt: string }[];
  relations: { fromId: string; toId: string; relation: string; createdBy: string; createdAt: string }[];
  consumers: { taskId: string | null; runId: string | null; agentId: string | null; via: string; version: number; at: string; snapshotId: string | null }[];
}

export interface Stats {
  projects: { id: string; name: string; repoPath: string; defaultBranch: string }[];
  agents: Agent[];
  tasks: Record<"backlog" | "ready" | "running" | "blocked" | "review" | "completed" | "failed", number>;
  reviewQueue: number;
  runs: {
    windowDays: number;
    total: number;
    outcomes: Record<string, number>;
    durationMs: { p50: number | null; p90: number | null; max: number | null };
    usage: { inputTokens: number; outputTokens: number; costUsd: number; runsWithUsage: number };
    recent: { id: string; taskId: string; taskTitle: string; agentName: string; status: string; startedAt: string; durationMs: number | null; usage: Record<string, number> }[];
  };
  knowledge: { id: string; projectId: string; type: string; title: string; status: string; sourceActor: string; createdAt: string }[];
}

export interface Workflow {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  isTemplate: boolean;
  graph: WorkflowGraph;
  version: number;
  createdAt: string;
  updatedAt: string;
}
