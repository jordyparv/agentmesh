"use client";
import { ArrowLeft, Pause, Pencil, Play, RotateCcw, Square } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalActions } from "@/components/approval-actions";
import { KnowledgeStatusBadge, RunStatusBadge, TaskStatusBadge } from "@/components/badges";
import { DiffView } from "@/components/diff-view";
import { TaskForm, type TaskFormValue } from "@/components/task-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useApi, useEventStream } from "@/lib/hooks";
import type { Agent, ArtifactMeta, EngineEvent, KnowledgeRecord, Run, Task, TaskDetail, Validation } from "@/lib/types";
import { cn, duration, shortSha, timeAgo } from "@/lib/utils";

type TabKey = "activity" | "runs" | "changes" | "validation" | "context" | "knowledge";

const EVENT_TONE: Record<string, string> = { "agent.error": "text-danger", "run.error": "text-danger", "agent.stderr": "text-muted-foreground", "task.status": "font-medium", "validation.gate": "text-info" };

function describeEvent(e: EngineEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "task.status":
      return `${p.from} → ${p.to} · ${p.reason ?? ""}`;
    case "validation.gate":
      return `${p.gate}: ${p.passed ? "passed" : "FAILED"}`;
    case "agent.collaboration":
      return `${p.op} ${JSON.stringify(p.input).slice(0, 200)}`;
    case "run.finished":
      return `run finished: ${p.status}${p.errorClass ? ` (${p.errorClass})` : ""}`;
    default:
      return String(p.message ?? p.reason ?? (Object.keys(p).length ? JSON.stringify(p).slice(0, 300) : ""));
  }
}

function EventLog({ taskId }: { taskId: string }) {
  const { data: history } = useApi<EngineEvent[]>(`/tasks/${taskId}/events?limit=2000`);
  const [live, setLive] = useState<EngineEvent[]>([]);
  const state = useEventStream(`taskId=${taskId}`, useCallback((e: EngineEvent) => setLive((x) => [...x, e]), []));
  const [filter, setFilter] = useState<"all" | "agent" | "engine">("all");
  const bottom = useRef<HTMLLIElement>(null);
  const all = useMemo(() => {
    const m = new Map<number, EngineEvent>();
    for (const e of [...(history ?? []), ...live]) m.set(e.id, e);
    return [...m.values()].sort((a, b) => a.id - b.id);
  }, [history, live]);
  const shown = all.filter((e) => filter === "all" || (filter === "agent" ? e.type.startsWith("agent.") : !e.type.startsWith("agent.")));
  // Block body: scrollIntoView may return a Promise, which React would treat as a cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [shown.length]);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <Badge tone={state === "live" ? "success" : "warning"} data-testid="sse-state">
          {state}
        </Badge>
        {(["all", "agent", "engine"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={cn("rounded px-1.5 py-0.5", filter === f ? "bg-accent font-medium" : "text-muted-foreground")}>
            {f}
          </button>
        ))}
        <span className="ml-auto text-muted-foreground">{all.length} events</span>
      </div>
      <ol className="max-h-[60vh] overflow-y-auto rounded-md border bg-muted/20 font-mono text-[12px]" data-testid="event-log" aria-live="polite">
        {shown.length ? (
          shown.map((e) => (
            <li key={e.id} className="flex gap-2 border-b border-border/50 px-2 py-1 last:border-0">
              <time className="shrink-0 text-muted-foreground">{new Date(e.createdAt).toLocaleTimeString()}</time>
              <span className="w-36 shrink-0 truncate text-muted-foreground">{e.type}</span>
              <span className={cn("min-w-0 whitespace-pre-wrap break-words", EVENT_TONE[e.type])}>{describeEvent(e)}</span>
            </li>
          ))
        ) : (
          <li className="p-3 text-muted-foreground">No events yet.</li>
        )}
        <li ref={bottom} aria-hidden className="h-0" />
      </ol>
    </div>
  );
}

function Runs({ taskId }: { taskId: string }) {
  const { data } = useApi<{ run: Run; agentName: string; agentKind: string }[]>(`/tasks/${taskId}/runs`, { refreshInterval: 4000 });
  if (!data) return <Loading />;
  if (!data.length) return <Empty title="No runs yet" />;
  return (
    <ul className="space-y-3">
      {data.map(({ run, agentName }) => (
        <li key={run.id} className="rounded-md border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Attempt {run.attempt}</span>
            <RunStatusBadge status={run.status} />
            <span className="text-muted-foreground">{agentName}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {timeAgo(run.startedAt)} · {duration(run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null)}
            </span>
          </div>
          {run.errorClass ? (
            <p className="mt-1 text-xs text-danger">
              {run.errorClass}: {run.errorMessage}
            </p>
          ) : null}
          {run.summary ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{run.summary}</pre> : null}
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            {Object.entries(run.usage).map(([k, v]) => (
              <span key={k}>
                {k}: {k === "costUsd" ? `$${Number(v).toFixed(4)}` : k === "durationMs" ? duration(v) : Number(v).toLocaleString()}
              </span>
            ))}
            {run.contextSnapshotId ? <span>context {run.contextSnapshotId.slice(0, 8)}</span> : null}
            <span>worker {run.workerId}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Changes({ taskId }: { taskId: string }) {
  const { data: arts } = useApi<ArtifactMeta[]>(`/tasks/${taskId}/artifacts`);
  const latestDiff = arts?.find((a) => a.kind === "diff");
  const latestFiles = arts?.find((a) => a.kind === "changed-files");
  const { data: diff } = useApi<{ content: string }>(latestDiff ? `/artifacts/${latestDiff.id}` : null);
  const { data: files } = useApi<{ content: string }>(latestFiles ? `/artifacts/${latestFiles.id}` : null);
  const [open, setOpen] = useState<string | null>(null);
  const { data: opened } = useApi<{ content: string; name: string; kind: string }>(open ? `/artifacts/${open}` : null);
  if (!arts) return <Loading />;
  const changed = files ? (JSON.parse(files.content) as { path: string; status: string }[]) : [];
  return (
    <div className="space-y-3">
      {changed.length ? (
        <ul className="flex flex-wrap gap-1.5 text-xs" aria-label="Changed files">
          {changed.map((f) => (
            <li key={f.path} className="rounded border px-1.5 py-0.5 font-mono">
              <span className={cn("mr-1 font-semibold", f.status === "A" ? "text-success" : f.status === "D" ? "text-danger" : "text-info")}>{f.status}</span>
              {f.path}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No changed files recorded.</p>
      )}
      {diff ? <DiffView diff={diff.content} /> : null}
      {arts.filter((a) => !["diff", "changed-files"].includes(a.kind)).length ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Artifacts</h3>
          <ul className="space-y-1 text-xs">
            {arts
              .filter((a) => !["diff", "changed-files"].includes(a.kind))
              .map((a) => (
                <li key={a.id}>
                  <button className="hover:underline" onClick={() => setOpen(open === a.id ? null : a.id)}>
                    <Badge>{a.kind}</Badge> {a.name} <span className="text-muted-foreground">({a.sizeBytes} B)</span>
                  </button>
                </li>
              ))}
          </ul>
          {opened ? (
            opened.kind === "screenshot" && opened.content.startsWith("data:image/") ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URI artifact
              <img alt={opened.name} src={opened.content} className="mt-2 max-w-full rounded border" />
            ) : (
              <pre className="mt-2 max-h-80 overflow-auto rounded border bg-muted/30 p-2 text-xs">{opened.content}</pre>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Validations({ taskId }: { taskId: string }) {
  const { data } = useApi<Validation[]>(`/tasks/${taskId}/validations`, { refreshInterval: 4000 });
  if (!data) return <Loading />;
  if (!data.length) return <Empty title="No quality gates have run yet" />;
  return (
    <ul className="space-y-1.5 text-sm" data-testid="validations">
      {data.map((v) => (
        <li key={v.id} className="rounded-md border p-2">
          <div className="flex items-center gap-2">
            <Badge tone={v.passed ? "success" : "danger"}>{v.passed ? "pass" : "fail"}</Badge>
            <span className="font-mono text-xs">{v.gate}</span>
            <Badge>{v.stage}</Badge>
            <span className="ml-auto text-xs text-muted-foreground">{timeAgo(v.createdAt)}</span>
          </div>
          {!v.passed || v.gate.startsWith("command:") ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted-foreground">detail</summary>
              <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(v.detail, null, 2)}</pre>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ContextTab({ taskId }: { taskId: string }) {
  const { data: snaps } = useApi<{ id: string; sha256: string; sourceCommitSha: string | null; tokenEstimate: number; tokenBudget: number; createdAt: string }[]>(`/tasks/${taskId}/context`);
  const [sel, setSel] = useState<string | null>(null);
  const id = sel ?? snaps?.[0]?.id ?? null;
  const { data: snap } = useApi<{ rendered: string; sections: { title: string; source: string; truncated: boolean }[]; knowledge: { knowledgeId: string; title: string; version: number; status: string }[] }>(id ? `/context/${id}` : null);
  if (!snaps) return <Loading />;
  if (!snaps.length) return <Empty title="No context snapshot yet">A snapshot is compiled immediately before each run and stored immutably.</Empty>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select aria-label="Snapshot" className="h-7 rounded border bg-background px-1" value={id ?? ""} onChange={(e) => setSel(e.target.value)}>
          {snaps.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.createdAt).toLocaleString()} · {s.id.slice(0, 8)}
            </option>
          ))}
        </select>
        {snaps.find((s) => s.id === id) ? (
          <span className="text-muted-foreground">
            sha256 {snaps.find((s) => s.id === id)!.sha256.slice(0, 12)} · ~{snaps.find((s) => s.id === id)!.tokenEstimate} / {snaps.find((s) => s.id === id)!.tokenBudget} tokens · base {shortSha(snaps.find((s) => s.id === id)!.sourceCommitSha)}
          </span>
        ) : null}
      </div>
      {snap ? (
        <>
          <div className="flex flex-wrap gap-1">
            {snap.sections.map((s) => (
              <Badge key={s.title} tone={s.truncated ? "warning" : "neutral"}>
                {s.title}
                {s.truncated ? " (truncated)" : ""}
              </Badge>
            ))}
          </div>
          {snap.knowledge.length ? (
            <p className="text-xs text-muted-foreground">
              Knowledge delivered:{" "}
              {snap.knowledge.map((k) => (
                <Link key={k.knowledgeId} href={`/knowledge?record=${k.knowledgeId}`} className="mr-2 underline">
                  {k.title} (v{k.version})
                </Link>
              ))}
            </p>
          ) : null}
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-3 text-xs" data-testid="context-rendered">
            {snap.rendered}
          </pre>
        </>
      ) : (
        <Loading />
      )}
    </div>
  );
}

function KnowledgeTab({ taskId }: { taskId: string }) {
  const { data } = useApi<{ consumed: { knowledgeId: string; title: string; status: string; type: string; via: string; version: number; at: string }[]; published: KnowledgeRecord[] }>(`/tasks/${taskId}/knowledge`, { refreshInterval: 5000 });
  if (!data) return <Loading />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section>
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Published by this task</h3>
        {data.published.length ? (
          <ul className="space-y-1 text-sm">
            {data.published.map((k) => (
              <li key={k.id} className="flex items-center gap-2">
                <KnowledgeStatusBadge status={k.status} />
                <Link className="truncate hover:underline" href={`/knowledge?record=${k.id}`}>
                  {k.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing published.</p>
        )}
      </section>
      <section>
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Received (context, search, refresh)</h3>
        {data.consumed.length ? (
          <ul className="space-y-1 text-sm">
            {data.consumed.map((k, i) => (
              <li key={`${k.knowledgeId}-${i}`} className="flex items-center gap-2">
                <KnowledgeStatusBadge status={k.status} />
                <Link className="truncate hover:underline" href={`/knowledge?record=${k.knowledgeId}`}>
                  {k.title}
                </Link>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  via {k.via} · v{k.version}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No shared knowledge consumed.</p>
        )}
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: task, error, mutate } = useApi<TaskDetail>(`/tasks/${id}`);
  const { data: agents } = useApi<Agent[]>("/agents");
  const { data: siblings } = useApi<Task[]>(task ? `/tasks?projectId=${task.projectId}` : null);
  const [tab, setTab] = useState<TabKey>("activity");
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  useEventStream(`taskId=${id}`, useCallback((e: EngineEvent) => {
    if (e.type.startsWith("task.") || e.type.startsWith("integration.")) void mutate();
  }, [mutate]));

  if (error) return <ErrorState error={error} />;
  if (!task) return <Loading />;
  const act = async (action: "start" | "pause" | "resume" | "cancel" | "retry") => {
    try {
      await api(`/tasks/${id}/actions`, { method: "POST", body: { action } });
      void mutate();
    } catch (e) {
      toast("danger", e instanceof Error ? e.message : String(e));
    }
  };
  const save = async (v: TaskFormValue) => {
    const { autoStart: _a, kind: _k, ...patch } = v;
    await api(`/tasks/${id}`, { method: "PATCH", body: patch });
    setEditing(false);
    void mutate();
  };
  const editable = ["PENDING", "READY", "BLOCKED", "FAILED", "CANCELLED", "RETRY_WAIT"].includes(task.status);
  const result = task.result as { summary?: string; structuredOutput?: { verdict?: string; summary?: string; findings?: { severity: string; file: string; message: string }[] } } | null;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/tasks" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="size-3" /> Board
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">{task.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="task-status">
              <TaskStatusBadge status={task.status} paused={task.paused} />
              <Badge>{task.kind}</Badge>
              <Badge>{task.modifiesCode ? "modifies code" : "read-only"}</Badge>
              {task.origin !== "user" ? <Badge tone="info">{task.origin.replace("_", " ")}</Badge> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(task.status === "PENDING" || task.status === "BLOCKED") && !task.autoStart ? (
              <Button onClick={() => void act("start")}>
                <Play /> Start
              </Button>
            ) : null}
            {!["COMPLETED", "FAILED", "CANCELLED"].includes(task.status) ? (
              <Button variant="outline" onClick={() => void act(task.paused ? "resume" : "pause")}>
                {task.paused ? <Play /> : <Pause />} {task.paused ? "Resume" : "Pause"}
              </Button>
            ) : null}
            {["FAILED", "CANCELLED"].includes(task.status) ? (
              <Button variant="outline" onClick={() => void act("retry")}>
                <RotateCcw /> Retry
              </Button>
            ) : null}
            {!["COMPLETED", "CANCELLED"].includes(task.status) ? (
              <Button variant="outline" onClick={() => void act("cancel")}>
                <Square /> Cancel
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setEditing(true)} disabled={!editable} title={editable ? "Edit requirements / reassign" : "Requirements are locked while the task is in flight"}>
              <Pencil /> Edit
            </Button>
          </div>
        </div>
      </div>

      {task.error ? <ErrorState error={new Error(`${(task.error as { class?: string }).class ?? "error"}: ${(task.error as { message?: string }).message ?? JSON.stringify(task.error)}`)} /> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Specification" />
            <CardBody className="space-y-3 text-sm">
              {task.description ? <p className="whitespace-pre-wrap">{task.description}</p> : <p className="text-muted-foreground">No description.</p>}
              {task.acceptanceCriteria.length ? (
                <div>
                  <h3 className="text-xs font-semibold text-muted-foreground">Acceptance criteria</h3>
                  <ul className="ml-4 list-disc">
                    {task.acceptanceCriteria.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {task.modifiesCode ? (
                <p className="text-xs text-muted-foreground">
                  File scope: <span className="font-mono">{task.allowedPaths.join(", ")}</span>
                </p>
              ) : null}
            </CardBody>
          </Card>

          {task.status === "AWAITING_APPROVAL" ? (
            <Card>
              <CardHeader title="Approval required" description="Validated and committed on the task branch. Review the evidence before integrating." actions={<Link className="text-xs underline" href={`/reviews/${task.id}`}>Open in Review Center</Link>} />
              <CardBody>
                <ApprovalActions taskId={task.id} onDone={() => void mutate()} />
              </CardBody>
            </Card>
          ) : null}

          {result?.structuredOutput?.verdict ? (
            <Card>
              <CardHeader title="Review findings" description={`Verdict: ${result.structuredOutput.verdict}`} />
              <CardBody className="space-y-2 text-sm">
                <p>{result.structuredOutput.summary}</p>
                <ul className="space-y-1">
                  {(result.structuredOutput.findings ?? []).map((f, i) => (
                    <li key={i} className="flex gap-2 text-xs">
                      <Badge tone={f.severity === "critical" || f.severity === "major" ? "danger" : f.severity === "minor" ? "warning" : "neutral"}>{f.severity}</Badge>
                      <span className="font-mono">{f.file}</span>
                      <span>{f.message}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <div className="px-4 pt-2">
              <Tabs<TabKey>
                value={tab}
                onChange={setTab}
                items={[
                  { value: "activity", label: "Live activity" },
                  { value: "runs", label: "Runs & logs" },
                  { value: "changes", label: "Changes" },
                  { value: "validation", label: "Validation" },
                  { value: "context", label: "Context" },
                  { value: "knowledge", label: "Knowledge" },
                ]}
              />
            </div>
            <CardBody>
              {tab === "activity" ? <EventLog taskId={id} /> : null}
              {tab === "runs" ? <Runs taskId={id} /> : null}
              {tab === "changes" ? <Changes taskId={id} /> : null}
              {tab === "validation" ? <Validations taskId={id} /> : null}
              {tab === "context" ? <ContextTab taskId={id} /> : null}
              {tab === "knowledge" ? <KnowledgeTab taskId={id} /> : null}
            </CardBody>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody className="py-2">
              <dl className="divide-y">
                <Row label="Agent">{task.agent ? `${task.agent.name}` : task.assignmentMode === "auto" ? "auto (by capability)" : "—"}</Row>
                <Row label="Assignment">{task.assignmentMode}</Row>
                <Row label="Priority">{task.priority}</Row>
                <Row label="Attempt">
                  {task.attempt} / {task.maxAttempts}
                </Row>
                <Row label="Timeout">{duration(task.timeoutMs)}</Row>
                <Row label="Approval">{task.modifiesCode ? (task.requiresApproval ? "human required" : "policy auto") : "n/a"}</Row>
                <Row label="Branch">
                  <span className="font-mono text-xs">{task.branch ?? "—"}</span>
                </Row>
                <Row label="Base → head">
                  <span className="font-mono text-xs">
                    {shortSha(task.baseSha)} → {shortSha(task.headSha)}
                  </span>
                </Row>
                <Row label="Worktree">
                  <span className="font-mono text-xs" title={task.worktreePath ?? ""}>
                    {task.worktreePath ? `…${task.worktreePath.slice(-28)}` : "—"}
                  </span>
                </Row>
                <Row label="Updated">{timeAgo(task.updatedAt)}</Row>
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Dependencies" />
            <CardBody className="space-y-1 py-2 text-sm">
              {task.dependencies.length ? (
                task.dependencies.map((d) => (
                  <Link key={d.id} href={`/tasks/${d.id}`} className="flex items-center gap-2 hover:underline">
                    <TaskStatusBadge status={d.status} />
                    <span className="truncate">{d.title}</span>
                  </Link>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">None</p>
              )}
            </CardBody>
          </Card>
          {task.children.length ? (
            <Card>
              <CardHeader title="Spawned tasks" description="Planned subtasks and agent help/review requests" />
              <CardBody className="space-y-1 py-2 text-sm">
                {task.children.map((c) => (
                  <Link key={c.id} href={`/tasks/${c.id}`} className="flex items-center gap-2 hover:underline">
                    <TaskStatusBadge status={c.status} />
                    <span className="truncate">{c.title}</span>
                    <Badge className="ml-auto">{c.origin.replace("_", " ")}</Badge>
                  </Link>
                ))}
              </CardBody>
            </Card>
          ) : null}
        </aside>
      </div>

      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit task" className="max-w-2xl">
        {editing ? <TaskForm mode="edit" initial={task} agents={agents ?? []} tasks={siblings ?? []} onSubmit={save} onCancel={() => setEditing(false)} /> : null}
      </Dialog>
    </div>
  );
}
