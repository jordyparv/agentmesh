import type { TaskStatus } from "./types";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const TASK_TONE: Record<TaskStatus, Tone> = {
  PENDING: "neutral",
  READY: "info",
  LEASED: "info",
  RUNNING: "info",
  VALIDATING: "info",
  COMPLETED: "success",
  BLOCKED: "warning",
  FAILED: "danger",
  CANCELLED: "neutral",
  RETRY_WAIT: "warning",
  AWAITING_APPROVAL: "warning",
};

export const KNOWLEDGE_TONE: Record<string, Tone> = {
  proposed: "neutral",
  evidenced: "info",
  verified: "success",
  accepted: "success",
  disputed: "warning",
  rejected: "danger",
  superseded: "neutral",
  stale: "warning",
};

export const RUN_TONE: Record<string, Tone> = { running: "info", succeeded: "success", failed: "danger", cancelled: "neutral", timed_out: "danger", abandoned: "warning" };

export const BOARD_COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "ready", label: "Ready" },
  { key: "running", label: "Running" },
  { key: "blocked", label: "Blocked" },
  { key: "review", label: "Review" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
] as const;
