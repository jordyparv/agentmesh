"use client";
import { Activity, Plus, Settings2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CAPABILITIES } from "@agentmesh/contracts";
import { HealthBadge, RunStatusBadge } from "@/components/badges";
import { PageHeader } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Agent, Run } from "@/lib/types";
import { duration, timeAgo } from "@/lib/utils";

interface AgentDraft {
  name: string;
  kind: string;
  enabled: boolean;
  maxConcurrency: number;
  model: string;
  allowWrite: boolean;
  sandbox: boolean;
  secretEnv: string;
  overrideCaps: boolean;
  capabilities: string[];
}

function AgentForm({ initial, kinds, onSubmit, onCancel, mode }: { initial?: Agent; kinds: { kind: string; displayName: string }[]; onSubmit: (body: Record<string, unknown>) => Promise<void>; onCancel: () => void; mode: "create" | "edit" }) {
  const [d, setD] = useState<AgentDraft>({
    name: initial?.name ?? "",
    kind: initial?.kind ?? kinds[0]?.kind ?? "claude",
    enabled: initial?.enabled ?? true,
    maxConcurrency: initial?.maxConcurrency ?? 1,
    model: String(initial?.config.model ?? ""),
    allowWrite: initial?.permissions.allowWrite ?? true,
    sandbox: initial?.permissions.sandbox ?? true,
    secretEnv: (initial?.permissions.secretEnv ?? []).join(", "),
    overrideCaps: false,
    capabilities: initial?.capabilities ?? [],
  });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const config = { ...(initial?.config ?? {}), ...(d.model ? { model: d.model } : {}) };
      if (!d.model) delete (config as Record<string, unknown>).model;
      await onSubmit({
        name: d.name,
        ...(mode === "create" ? { kind: d.kind } : {}),
        enabled: d.enabled,
        maxConcurrency: d.maxConcurrency,
        config,
        permissions: { allowWrite: d.allowWrite, sandbox: d.sandbox, secretEnv: d.secretEnv.split(/[,\s]+/).filter(Boolean) },
        ...(d.overrideCaps ? { capabilities: d.capabilities } : {}),
      });
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" htmlFor="af-name">
          <Input id="af-name" required value={d.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Provider adapter" htmlFor="af-kind">
          <Select id="af-kind" value={d.kind} disabled={mode === "edit"} onChange={(e) => set("kind", e.target.value)}>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Max concurrent runs" htmlFor="af-conc">
          <Input id="af-conc" type="number" min={1} max={32} value={d.maxConcurrency} onChange={(e) => set("maxConcurrency", Number(e.target.value))} />
        </Field>
        <Field label="Model (optional)" htmlFor="af-model" hint="Passed to the provider CLI as --model / -m">
          <Input id="af-model" value={d.model} onChange={(e) => set("model", e.target.value)} />
        </Field>
      </div>
      <fieldset className="space-y-1.5 rounded-md border p-2.5">
        <legend className="px-1 text-xs font-medium text-muted-foreground">Permissions</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.allowWrite} onChange={(e) => set("allowWrite", e.target.checked)} /> May modify files
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.sandbox} onChange={(e) => set("sandbox", e.target.checked)} /> Run inside OS sandbox (bubblewrap)
        </label>
        <Field label="Secret environment variables" htmlFor="af-secrets" hint="Names only. Values are read on the worker host and never stored or shown.">
          <Input id="af-secrets" className="font-mono text-xs" placeholder="ANTHROPIC_API_KEY" value={d.secretEnv} onChange={(e) => set("secretEnv", e.target.value)} />
        </Field>
      </fieldset>
      <fieldset className="space-y-1.5 rounded-md border p-2.5">
        <legend className="px-1 text-xs font-medium text-muted-foreground">Capabilities</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.overrideCaps} onChange={(e) => set("overrideCaps", e.target.checked)} /> Override discovered capabilities
        </label>
        <div className="flex flex-wrap gap-1.5">
          {CAPABILITIES.map((c) => (
            <label key={c} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
              <input type="checkbox" disabled={!d.overrideCaps} checked={d.capabilities.includes(c)} onChange={(e) => set("capabilities", e.target.checked ? [...d.capabilities, c] : d.capabilities.filter((x) => x !== c))} />
              {c}
            </label>
          ))}
        </div>
      </fieldset>
      {err ? <ErrorState error={err} /> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !d.name.trim()}>
          {mode === "create" ? "Register and probe" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function History({ agentId }: { agentId: string }) {
  const { data } = useApi<{ run: Run; taskTitle: string }[]>(`/agents/${agentId}/runs`);
  if (!data) return <Loading />;
  if (!data.length) return <p className="px-4 py-3 text-xs text-muted-foreground">No runs yet.</p>;
  return (
    <ul className="divide-y text-sm">
      {data.slice(0, 20).map(({ run, taskTitle }) => (
        <li key={run.id} className="flex items-center gap-2 px-4 py-1.5">
          <RunStatusBadge status={run.status} />
          <Link href={`/tasks/${run.taskId}`} className="min-w-0 flex-1 truncate hover:underline">
            {taskTitle}
          </Link>
          <span className="text-xs text-muted-foreground">{duration(run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null)}</span>
          <span className="w-16 text-right text-xs text-muted-foreground">{timeAgo(run.startedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function AgentsPage() {
  const { data, error, isLoading, mutate } = useApi<Agent[]>("/agents", { refreshInterval: 10_000 });
  const { data: kinds } = useApi<{ kind: string; displayName: string }[]>("/integrations");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const toast = useToast();

  const probe = async (a: Agent) => {
    setProbing(a.id);
    try {
      const r = await api<Agent>(`/agents/${a.id}/probe`, { method: "POST", body: {} });
      toast(r.health === "healthy" ? "success" : "danger", `${r.name}: ${r.health} (${r.integrationMode}) ${r.version ?? ""}`);
      void mutate();
    } catch (e) {
      toast("danger", e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Agents"
        description="Provider adapters, capabilities, limits and permissions. Credentials are referenced by environment variable name only."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> Register agent
          </Button>
        }
      />
      {error ? <ErrorState error={error} /> : null}
      {isLoading ? <Loading /> : null}
      {data && !data.length ? (
        <Card>
          <Empty title="No agents registered">Register Codex, Claude Code or Antigravity. `pnpm agentmesh agents seed` registers installed CLIs automatically.</Empty>
        </Card>
      ) : null}
      <div className="space-y-3">
        {data?.map((a) => (
          <Card key={a.id} data-testid={`agent-${a.name}`}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {a.name} <span className="font-normal text-muted-foreground">· {a.kind}</span> {!a.enabled ? <Badge tone="warning">disabled</Badge> : null}
                </span>
              }
              description={a.probeDetail}
              actions={
                <>
                  <HealthBadge health={a.health} mode={a.integrationMode} />
                  <Button size="sm" variant="outline" onClick={() => void probe(a)} disabled={probing === a.id}>
                    <Activity /> {probing === a.id ? "Testing…" : "Test connectivity"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(a)}>
                    <Settings2 /> Configure
                  </Button>
                </>
              }
            />
            <CardBody className="grid gap-3 py-3 text-sm sm:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">Version</div>
                {a.version ?? "—"}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Concurrency</div>
                {a.activeRuns ?? 0} / {a.maxConcurrency}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Permissions</div>
                {a.permissions.allowWrite ? "write" : "read-only"} · {a.permissions.sandbox ? "sandboxed" : "UNSANDBOXED"}
                {a.permissions.secretEnv.length ? ` · ${a.permissions.secretEnv.length} secret ref(s)` : ""}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Last probe</div>
                {timeAgo(a.lastProbeAt)}
              </div>
              <div className="sm:col-span-4">
                <div className="mb-1 text-xs text-muted-foreground">Capabilities</div>
                <div className="flex flex-wrap gap-1">
                  {a.capabilities.length ? a.capabilities.map((c) => <Badge key={c}>{c}</Badge>) : <span className="text-xs text-muted-foreground">none discovered</span>}
                </div>
              </div>
            </CardBody>
            <div className="border-t">
              <button className="w-full px-4 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent" onClick={() => setHistoryFor(historyFor === a.id ? null : a.id)} aria-expanded={historyFor === a.id}>
                {historyFor === a.id ? "Hide" : "Show"} execution history
              </button>
              {historyFor === a.id ? <History agentId={a.id} /> : null}
            </div>
          </Card>
        ))}
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="Register agent" className="max-w-xl">
        {creating && kinds ? (
          <AgentForm
            mode="create"
            kinds={kinds}
            onCancel={() => setCreating(false)}
            onSubmit={async (body) => {
              const a = await api<Agent>("/agents", { method: "POST", body });
              toast(a.health === "healthy" ? "success" : "danger", `${a.name}: ${a.health} · ${a.integrationMode}`);
              setCreating(false);
              void mutate();
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={`Configure ${editing?.name ?? ""}`} className="max-w-xl">
        {editing && kinds ? (
          <AgentForm
            mode="edit"
            initial={editing}
            kinds={kinds}
            onCancel={() => setEditing(null)}
            onSubmit={async (body) => {
              await api(`/agents/${editing.id}`, { method: "PATCH", body });
              setEditing(null);
              void mutate();
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}
