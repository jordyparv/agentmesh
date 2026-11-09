"use client";
import { Pause, Play, Plus, RotateCcw, Square } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { boardColumn } from "@agentmesh/contracts";
import { TaskStatusBadge } from "@/components/badges";
import { useProject } from "@/components/project-context";
import { PageHeader } from "@/components/shell";
import { TaskForm, type TaskFormValue } from "@/components/task-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useApi, useEventStream } from "@/lib/hooks";
import { BOARD_COLUMNS } from "@/lib/status";
import type { Agent, Task } from "@/lib/types";
import { timeAgo } from "@/lib/utils";

type Action = "start" | "pause" | "resume" | "cancel" | "retry";

/** Which lifecycle actions the engine will accept from this state (the API re-checks). */
function actionsFor(t: Task): Action[] {
  if (t.status === "COMPLETED") return [];
  const out: Action[] = [];
  if ((t.status === "PENDING" || t.status === "BLOCKED") && !t.autoStart) out.push("start");
  if (["FAILED", "CANCELLED"].includes(t.status)) out.push("retry");
  if (!["FAILED", "CANCELLED"].includes(t.status)) out.push(t.paused ? "resume" : "pause");
  if (t.status !== "CANCELLED") out.push("cancel");
  return out;
}
const ICON: Record<Action, typeof Play> = { start: Play, resume: Play, pause: Pause, cancel: Square, retry: RotateCcw };

export default function TaskBoard() {
  const { projectId, project } = useProject();
  const toast = useToast();
  const tasksKey = projectId ? `/tasks?projectId=${projectId}` : null;
  const { data: tasks, error, isLoading, mutate } = useApi<Task[]>(tasksKey);
  const { data: agents } = useApi<Agent[]>("/agents");
  const [creating, setCreating] = useState(false);
  const live = useEventStream(projectId ? `projectId=${projectId}` : null, useCallback((e) => {
    if (e.type.startsWith("task.")) void mutate();
  }, [mutate]));

  const act = async (t: Task, action: Action) => {
    try {
      await api(`/tasks/${t.id}/actions`, { method: "POST", body: { action } });
      toast("success", `${action} → ${t.title}`);
      void mutate();
    } catch (e) {
      toast("danger", e instanceof Error ? e.message : String(e));
    }
  };
  const create = async (v: TaskFormValue) => {
    await api("/tasks", { method: "POST", body: { ...v, projectId, assignedAgentId: v.assignedAgentId ?? undefined } });
    setCreating(false);
    toast("success", `Created "${v.title}"`);
    void mutate();
  };
  const agentName = (id: string | null) => agents?.find((a) => a.id === id)?.name;

  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          <span className="inline-flex items-center gap-2">
            {project ? project.name : "Select a project"}
            <Badge tone={live === "live" ? "success" : live === "off" ? "neutral" : "warning"} aria-live="polite">
              {live === "live" ? "live" : live}
            </Badge>
          </span>
        }
        actions={
          <Button onClick={() => setCreating(true)} disabled={!projectId}>
            <Plus /> New task
          </Button>
        }
      />
      {error ? <ErrorState error={error} /> : null}
      {isLoading ? <Loading /> : null}
      {!projectId && !isLoading ? (
        <Empty title="No project selected" action={<Link className="text-xs underline" href="/projects">Register a repository</Link>} />
      ) : null}
      {tasks ? (
        <div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-2.5 overflow-x-auto pb-2" data-testid="task-board">
          {BOARD_COLUMNS.map((col) => {
            const items = tasks.filter((t) => boardColumn(t.status) === col.key).sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));
            return (
              <section key={col.key} aria-label={col.label} data-column={col.key} className="flex min-h-40 flex-col rounded-lg border bg-muted/40">
                <h2 className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {col.label} <span className="tabular-nums">{items.length}</span>
                </h2>
                <ul className="flex flex-1 flex-col gap-2 p-2">
                  {items.map((t) => (
                    <li key={t.id} className="rounded-md border bg-card p-2.5 shadow-xs" data-task-id={t.id}>
                      <Link href={`/tasks/${t.id}`} className="line-clamp-2 text-sm font-medium hover:underline">
                        {t.title}
                      </Link>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <TaskStatusBadge status={t.status} paused={t.paused} />
                        <Badge>{t.kind}</Badge>
                        {t.origin !== "user" ? <Badge tone="info">{t.origin.replace("_", " ")}</Badge> : null}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="truncate">{agentName(t.assignedAgentId) ?? (t.assignmentMode === "auto" ? "auto-assign" : "unassigned")}</span>
                        <span>
                          P{t.priority} · {timeAgo(t.updatedAt)}
                        </span>
                      </div>
                      {actionsFor(t).length ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {actionsFor(t).map((a) => {
                            const Icon = ICON[a];
                            return (
                              <Button key={a} variant="outline" size="sm" onClick={() => void act(t, a)} aria-label={`${a} ${t.title}`}>
                                <Icon className="size-3" /> {a}
                              </Button>
                            );
                          })}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}
      <Dialog open={creating} onClose={() => setCreating(false)} title="New task" className="max-w-2xl">
        {creating ? <TaskForm mode="create" agents={agents ?? []} tasks={tasks ?? []} onSubmit={create} onCancel={() => setCreating(false)} /> : null}
      </Dialog>
    </>
  );
}
