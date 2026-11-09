/**
 * Task lifecycle state machine. Pure and deterministic: the engine kernel
 * consults this table inside a transaction before every status change.
 */
export const TASK_STATUSES = [
  "PENDING",
  "READY",
  "LEASED",
  "RUNNING",
  "VALIDATING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "RETRY_WAIT",
  "AWAITING_APPROVAL",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const T: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ["READY", "BLOCKED", "CANCELLED"],
  BLOCKED: ["PENDING", "READY", "CANCELLED"],
  READY: ["LEASED", "PENDING", "BLOCKED", "CANCELLED"],
  // LEASED -> READY: lease released before start (e.g. pause). LEASED -> RETRY_WAIT: lease expired.
  LEASED: ["RUNNING", "READY", "RETRY_WAIT", "FAILED", "CANCELLED"],
  // RUNNING -> READY: paused mid-run (run aborted, task re-queued once resumed).
  RUNNING: ["VALIDATING", "READY", "RETRY_WAIT", "FAILED", "CANCELLED"],
  VALIDATING: ["COMPLETED", "AWAITING_APPROVAL", "RETRY_WAIT", "FAILED", "CANCELLED"],
  // AWAITING_APPROVAL -> READY: changes requested. -> FAILED: rejected or integration failed.
  AWAITING_APPROVAL: ["COMPLETED", "READY", "FAILED", "CANCELLED"],
  RETRY_WAIT: ["READY", "CANCELLED"],
  // Manual retry of failed/cancelled tasks.
  FAILED: ["READY", "CANCELLED"],
  CANCELLED: ["READY"],
  COMPLETED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return T[from].includes(to);
}

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return T[from];
}

export class InvalidTransitionError extends Error {
  readonly code = "INVALID_TRANSITION";
  constructor(
    readonly taskId: string,
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Illegal task transition ${from} -> ${to} for task ${taskId}`);
  }
}

/** Statuses in which a worker holds a lease on the task. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ["LEASED", "RUNNING", "VALIDATING"];
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["COMPLETED"];

/** Portal board column for a status. */
export type BoardColumn = "backlog" | "ready" | "running" | "blocked" | "review" | "completed" | "failed";
export function boardColumn(s: TaskStatus): BoardColumn {
  switch (s) {
    case "PENDING":
      return "backlog";
    case "READY":
    case "RETRY_WAIT":
      return "ready";
    case "LEASED":
    case "RUNNING":
    case "VALIDATING":
      return "running";
    case "BLOCKED":
      return "blocked";
    case "AWAITING_APPROVAL":
      return "review";
    case "COMPLETED":
      return "completed";
    case "FAILED":
    case "CANCELLED":
      return "failed";
  }
}
