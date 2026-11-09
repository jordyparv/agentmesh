"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/input";
import { ErrorState } from "./ui/states";
import type { Agent, Task } from "@/lib/types";

const CAPS = ["plan", "architecture", "implement", "debug", "refactor", "test", "review", "browser", "visual-qa"] as const;
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export interface TaskFormValue {
  title: string;
  description: string;
  kind: "plan" | "implement" | "review" | "test" | "generic";
  priority: number;
  assignedAgentId: string | null;
  requiredCapabilities: string[];
  acceptanceCriteria: string[];
  allowedPaths?: string[];
  dependsOn: string[];
  autoStart?: boolean;
}

/** Create/edit form for task requirements. Validation of business rules happens in the API. */
export function TaskForm({
  initial,
  agents,
  tasks,
  mode,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<Task>;
  agents: Agent[];
  tasks: Task[];
  mode: "create" | "edit";
  onSubmit: (v: TaskFormValue) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [kind, setKind] = useState<TaskFormValue["kind"]>(initial?.kind ?? "implement");
  const [priority, setPriority] = useState(initial?.priority ?? 50);
  const [agentId, setAgentId] = useState(initial?.assignmentMode === "manual" ? (initial.assignedAgentId ?? "") : "");
  const [caps, setCaps] = useState<string[]>(initial?.requiredCapabilities ?? []);
  const [criteria, setCriteria] = useState((initial?.acceptanceCriteria ?? []).join("\n"));
  const [paths, setPaths] = useState((initial?.allowedPaths ?? []).join("\n"));
  const [deps, setDeps] = useState<string[]>(initial?.dependsOn ?? []);
  const [autoStart, setAutoStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title,
        description,
        kind,
        priority,
        assignedAgentId: agentId || null,
        requiredCapabilities: caps,
        acceptanceCriteria: lines(criteria),
        ...(lines(paths).length ? { allowedPaths: lines(paths) } : {}),
        dependsOn: deps,
        ...(mode === "create" ? { autoStart } : {}),
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const candidates = tasks.filter((t) => t.id !== initial?.id);
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={mode === "create" ? "Create task" : "Edit task"}>
      <Field label="Title" htmlFor="tf-title">
        <Input id="tf-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Requirements" htmlFor="tf-desc">
        <Textarea id="tf-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What should be done and why." />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Kind" htmlFor="tf-kind" hint={kind === "plan" || kind === "review" ? "Read-only" : "Modifies code"}>
          <Select id="tf-kind" value={kind} onChange={(e) => setKind(e.target.value as TaskFormValue["kind"])} disabled={mode === "edit"}>
            {["implement", "plan", "review", "test", "generic"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
        </Field>
        <Field label="Priority (0–100)" htmlFor="tf-prio">
          <Input id="tf-prio" type="number" min={0} max={100} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
        </Field>
        <Field label="Agent" htmlFor="tf-agent" hint={agentId ? "Manual assignment" : "Routed by capability"}>
          <Select id="tf-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Automatic</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.enabled || a.integrationMode !== "automated"}>
                {a.name} ({a.kind}){a.integrationMode !== "automated" ? ` · ${a.integrationMode}` : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Required capabilities">
        <div className="flex flex-wrap gap-1.5">
          {CAPS.map((c) => (
            <label key={c} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
              <input type="checkbox" checked={caps.includes(c)} onChange={(e) => setCaps(e.target.checked ? [...caps, c] : caps.filter((x) => x !== c))} />
              {c}
            </label>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Acceptance criteria (one per line)" htmlFor="tf-crit">
          <Textarea id="tf-crit" rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </Field>
        <Field label="Allowed paths (globs, one per line)" htmlFor="tf-paths" hint="Empty = project default">
          <Textarea id="tf-paths" rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="src/**" className="font-mono text-xs" />
        </Field>
      </div>
      <Field label="Depends on">
        <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
          {candidates.length ? (
            candidates.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={deps.includes(t.id)} onChange={(e) => setDeps(e.target.checked ? [...deps, t.id] : deps.filter((x) => x !== t.id))} />
                <span className="truncate">{t.title}</span>
                <span className="ml-auto text-muted-foreground">{t.status.toLowerCase()}</span>
              </label>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No other tasks in this project.</p>
          )}
        </div>
      </Field>
      {mode === "create" ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} /> Start when dependencies are satisfied
        </label>
      ) : null}
      {error ? <ErrorState error={error} /> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !title.trim()}>
          {mode === "create" ? "Create task" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
