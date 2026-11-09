import { auditLog, events, type DbOrTx } from "@agentmesh/database";
import { defaultRedactor } from "@agentmesh/observability";

export interface EventInput {
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}

/** Durable event log; SSE streams read from it, so events survive restarts and cross processes. */
export async function publishEvent(db: DbOrTx, e: EventInput): Promise<void> {
  await db.insert(events).values({
    projectId: e.projectId ?? null,
    taskId: e.taskId ?? null,
    runId: e.runId ?? null,
    type: e.type,
    payload: defaultRedactor.redactDeep(e.payload ?? {}),
  });
}

export async function audit(db: DbOrTx, a: { actor: string; action: string; targetType: string; targetId?: string | null; detail?: Record<string, unknown> }): Promise<void> {
  await db.insert(auditLog).values({ actor: a.actor, action: a.action, targetType: a.targetType, targetId: a.targetId ?? null, detail: defaultRedactor.redactDeep(a.detail ?? {}) });
}
