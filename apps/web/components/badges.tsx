import { Badge } from "./ui/badge";
import { KNOWLEDGE_TONE, RUN_TONE, TASK_TONE } from "@/lib/status";
import type { TaskStatus } from "@/lib/types";

export const TaskStatusBadge = ({ status, paused }: { status: TaskStatus; paused?: boolean }) => (
  <span className="inline-flex gap-1">
    <Badge tone={TASK_TONE[status]}>{status.replace("_", " ").toLowerCase()}</Badge>
    {paused ? <Badge tone="warning">paused</Badge> : null}
  </span>
);
export const KnowledgeStatusBadge = ({ status }: { status: string }) => <Badge tone={KNOWLEDGE_TONE[status] ?? "neutral"}>{status}</Badge>;
export const RunStatusBadge = ({ status }: { status: string }) => <Badge tone={RUN_TONE[status] ?? "neutral"}>{status.replace("_", " ")}</Badge>;
export const HealthBadge = ({ health, mode }: { health: string; mode: string }) => (
  <span className="inline-flex gap-1">
    <Badge tone={health === "healthy" ? "success" : health === "unavailable" ? "danger" : "neutral"}>{health}</Badge>
    <Badge tone={mode === "automated" ? "info" : mode === "assisted" ? "warning" : "neutral"}>{mode}</Badge>
  </span>
);
