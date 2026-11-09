"use client";
import { CheckCheck, Plus, RefreshCcw, Search, ShieldCheck, ThumbsDown, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { KNOWLEDGE_STATUSES, KNOWLEDGE_TYPES } from "@agentmesh/contracts";
import { KnowledgeStatusBadge } from "@/components/badges";
import { useProject } from "@/components/project-context";
import { PageHeader } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Agent, KnowledgeDetail, KnowledgeRecord, SearchHit } from "@/lib/types";
import { cn, shortSha, timeAgo } from "@/lib/utils";

const label = (s: string) => s.replace(/_/g, " ");

function ActionBar({ detail, onDone }: { detail: KnowledgeDetail; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  const s = detail.record.status;
  const run = async (action: string) => {
    setErr(null);
    try {
      const body = action === "verify" ? { action, comment, evidence: comment ? [{ kind: "note", reference: "portal review", excerpt: comment }] : [] } : { action, comment };
      await api(`/knowledge/${detail.record.id}/actions`, { method: "POST", body });
      toast("success", `${action}: ${detail.record.title}`);
      setComment("");
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="space-y-2">
      <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment / evidence note (required for dispute and reject)" aria-label="Action comment" />
      {err ? <ErrorState error={err} /> : null}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={!["proposed", "evidenced", "disputed"].includes(s)} onClick={() => void run("verify")}>
          <ShieldCheck /> Verify
        </Button>
        <Button size="sm" variant="outline" disabled={["stale", "rejected", "superseded", "accepted"].includes(s)} onClick={() => void run("accept")}>
          <CheckCheck /> Accept
        </Button>
        <Button size="sm" variant="outline" disabled={["rejected", "superseded"].includes(s) || !comment.trim()} onClick={() => void run("dispute")}>
          <TriangleAlert /> Dispute
        </Button>
        <Button size="sm" variant="outline" disabled={s === "rejected" || !comment.trim()} onClick={() => void run("reject")}>
          <ThumbsDown /> Reject
        </Button>
        <Button size="sm" variant="outline" disabled={s === "proposed"} onClick={() => void run("revalidate")} title="Mark for revalidation (back to proposed)">
          <RefreshCcw /> Revalidate
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Only verified and accepted knowledge is presented to agents as authoritative; stale records must be revalidated before they can be verified again.</p>
    </div>
  );
}

function DetailPanel({ id, agents, onChanged }: { id: string; agents: Map<string, string>; onChanged: () => void }) {
  const { data, error, mutate } = useApi<KnowledgeDetail>(`/knowledge/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const r = data.record;
  const who = (actor: string) => (actor.startsWith("agent:") ? (agents.get(actor.slice(6)) ?? actor) : actor);
  return (
    <div className="space-y-4" data-testid="knowledge-detail">
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <KnowledgeStatusBadge status={r.status} />
          <Badge>{label(r.type)}</Badge>
          <Badge>scope: {r.scope}</Badge>
          {data.authoritative ? <Badge tone="success">authoritative</Badge> : <Badge tone="warning">not authoritative</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">v{r.version}</span>
        </div>
        <h2 className="mt-2 font-semibold">{r.title}</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm">{r.statement}</p>
        {r.statusReason ? <p className="mt-1 text-xs text-muted-foreground">Status reason: {r.statusReason}</p> : null}
        {r.affectedPaths.length ? <p className="mt-1 font-mono text-xs text-muted-foreground">{r.affectedPaths.join(", ")}</p> : null}
      </div>
      <section>
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Provenance</h3>
        <dl className="grid grid-cols-[110px_1fr] gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Source</dt>
          <dd>{who(r.sourceActor)}</dd>
          <dt className="text-muted-foreground">Task</dt>
          <dd>{r.sourceTaskId ? <Link className="underline" href={`/tasks/${r.sourceTaskId}`}>{r.sourceTaskId.slice(0, 8)}</Link> : "—"}</dd>
          <dt className="text-muted-foreground">Run</dt>
          <dd className="font-mono">{r.sourceRunId?.slice(0, 8) ?? "—"}</dd>
          <dt className="text-muted-foreground">Commit</dt>
          <dd className="font-mono">{shortSha(r.sourceCommitSha)}</dd>
          <dt className="text-muted-foreground">Verified by</dt>
          <dd>{r.verifiedBy ? `${who(r.verifiedBy)} · ${timeAgo(r.verifiedAt)}` : "—"}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{timeAgo(r.createdAt)}</dd>
        </dl>
      </section>
      <section>
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Evidence ({data.evidence.length})</h3>
        {data.evidence.length ? (
          <ul className="space-y-1 text-xs">
            {data.evidence.map((e) => (
              <li key={e.id} className="rounded border p-1.5">
                <Badge>{e.kind}</Badge> <span className="font-mono">{e.reference}</span> <span className="text-muted-foreground">· {who(e.addedBy)}</span>
                {e.excerpt ? <pre className="mt-1 whitespace-pre-wrap text-muted-foreground">{e.excerpt}</pre> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No evidence attached.</p>
        )}
      </section>
      <section>
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Relationships</h3>
        {data.relations.length ? (
          <ul className="space-y-1 text-xs">
            {data.relations.map((rel, i) => {
              const outgoing = rel.fromId === r.id;
              const other = outgoing ? rel.toId : rel.fromId;
              return (
                <li key={i}>
                  {outgoing ? "this" : <Link className="underline" href={`/knowledge?record=${other}`}>{other.slice(0, 8)}</Link>} <Badge tone={rel.relation === "contradicts" ? "danger" : "neutral"}>{label(rel.relation)}</Badge> {outgoing ? <Link className="underline" href={`/knowledge?record=${other}`}>{other.slice(0, 8)}</Link> : "this"}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No related records.</p>
        )}
      </section>
      <section>
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Consumed by ({data.consumers.length})</h3>
        {data.consumers.length ? (
          <ul className="space-y-0.5 text-xs" data-testid="consumers">
            {data.consumers.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span>{c.agentId ? (agents.get(c.agentId) ?? c.agentId.slice(0, 8)) : "—"}</span>
                <Badge>{c.via}</Badge>
                <span className="text-muted-foreground">v{c.version}</span>
                {c.taskId ? (
                  <Link className="underline" href={`/tasks/${c.taskId}`}>
                    task {c.taskId.slice(0, 8)}
                  </Link>
                ) : null}
                {c.snapshotId ? <span className="font-mono text-muted-foreground">ctx {c.snapshotId.slice(0, 8)}</span> : null}
                <span className="ml-auto text-muted-foreground">{timeAgo(c.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No agent has received this record yet.</p>
        )}
      </section>
      <ActionBar
        detail={data}
        onDone={() => {
          void mutate();
          onChanged();
        }}
      />
    </div>
  );
}

function PublishDialog({ projectId, open, onClose, onDone }: { projectId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<string>("architectural_decision");
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const [paths, setPaths] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    try {
      await api("/knowledge", { method: "POST", body: { projectId, type, title, statement, affectedPaths: paths.split("\n").map((p) => p.trim()).filter(Boolean) } });
      onDone();
      onClose();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Publish knowledge" footer={<Button onClick={() => void submit()} disabled={!title.trim() || !statement.trim()}>Publish</Button>}>
      <div className="space-y-3">
        <Field label="Type" htmlFor="kp-type">
          <Select id="kp-type" value={type} onChange={(e) => setType(e.target.value)}>
            {KNOWLEDGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" htmlFor="kp-title">
          <Input id="kp-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Statement" htmlFor="kp-st">
          <Textarea id="kp-st" rows={4} value={statement} onChange={(e) => setStatement(e.target.value)} />
        </Field>
        <Field label="Affected paths (one per line)" htmlFor="kp-paths" hint="Records about paths become stale when those files change.">
          <Textarea id="kp-paths" rows={2} className="font-mono text-xs" value={paths} onChange={(e) => setPaths(e.target.value)} />
        </Field>
        <p className="text-[11px] text-muted-foreground">Human-published records start as proposed too; accept them explicitly to make them authoritative.</p>
        {err ? <ErrorState error={err} /> : null}
      </div>
    </Dialog>
  );
}

function Conflicts({ projectId }: { projectId: string }) {
  const { data } = useApi<{ contradictions: { from?: KnowledgeRecord; to?: KnowledgeRecord; createdBy: string }[]; disputed: KnowledgeRecord[] }>(`/knowledge/conflicts?projectId=${projectId}`);
  if (!data) return <Loading />;
  if (!data.contradictions.length && !data.disputed.length) return <Empty title="No conflicting knowledge" />;
  return (
    <div className="space-y-3 p-3">
      {data.contradictions.map((c, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-2 text-sm md:grid-cols-[1fr_auto_1fr]">
          <Link href={`/knowledge?record=${c.from?.id}`} className="hover:underline">
            <KnowledgeStatusBadge status={c.from?.status ?? "?"} /> {c.from?.title}
          </Link>
          <Badge tone="danger" className="self-center">
            contradicts
          </Badge>
          <Link href={`/knowledge?record=${c.to?.id}`} className="hover:underline">
            <KnowledgeStatusBadge status={c.to?.status ?? "?"} /> {c.to?.title}
          </Link>
        </div>
      ))}
      {data.disputed.map((d) => (
        <Link key={d.id} href={`/knowledge?record=${d.id}`} className="flex items-center gap-2 text-sm hover:underline">
          <KnowledgeStatusBadge status="disputed" /> {d.title} <span className="text-xs text-muted-foreground">{d.statusReason}</span>
        </Link>
      ))}
    </div>
  );
}

function Explorer() {
  const { projectId, project } = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("record");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [tab, setTab] = useState<"records" | "conflicts">("records");
  const [publishing, setPublishing] = useState(false);
  const { data: agentList } = useApi<Agent[]>("/agents");
  const agents = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a.name])), [agentList]);
  const qs = new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(query ? { q: query } : {}), ...(types.length ? { types: types.join(",") } : {}), ...(statuses.length ? { statuses: statuses.join(",") } : {}) });
  const { data, error, isLoading, mutate } = useApi<{ mode: string; results: SearchHit[] }>(projectId ? `/knowledge?${qs}` : null);
  useEffect(() => {
    setQuery("");
  }, [projectId]);
  const select = (id: string) => router.replace(`/knowledge?record=${id}`, { scroll: false });
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <>
      <PageHeader
        title="Shared Memory"
        description={project ? `Knowledge fabric for ${project.name}` : "Select a project"}
        actions={
          <Button variant="outline" onClick={() => setPublishing(true)} disabled={!projectId}>
            <Plus /> Publish
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_440px]">
        <Card className="min-w-0">
          <div className="space-y-2 border-b p-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(q);
              }}
            >
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
                <Input className="pl-7" placeholder="Search knowledge (full-text + semantic + paths)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search knowledge" />
              </div>
              <Button type="submit" variant="outline">
                Search
              </Button>
            </form>
            <div className="flex flex-wrap gap-1" aria-label="Filter by type">
              {KNOWLEDGE_TYPES.map((t) => (
                <button key={t} onClick={() => toggle(types, setTypes, t)} aria-pressed={types.includes(t)} className={cn("rounded border px-1.5 py-0.5 text-[11px]", types.includes(t) ? "border-foreground bg-accent" : "text-muted-foreground")}>
                  {label(t)}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1" aria-label="Filter by status">
              {KNOWLEDGE_STATUSES.map((s) => (
                <button key={s} onClick={() => toggle(statuses, setStatuses, s)} aria-pressed={statuses.includes(s)} className={cn("rounded border px-1.5 py-0.5 text-[11px]", statuses.includes(s) ? "border-foreground bg-accent" : "text-muted-foreground")}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="px-3 pt-1">
            <Tabs value={tab} onChange={setTab} items={[{ value: "records", label: "Records" }, { value: "conflicts", label: "Conflicts" }]} />
          </div>
          {tab === "conflicts" && projectId ? <Conflicts projectId={projectId} /> : null}
          {tab === "records" ? (
            <>
              {error ? <ErrorState error={error} className="m-3" /> : null}
              {isLoading ? <Loading /> : null}
              {data && !data.results.length ? <Empty title="No knowledge matches">Agents publish discoveries with knowledge.publish during runs.</Empty> : null}
              <ul className="divide-y" data-testid="knowledge-list">
                {data?.results.map((h) => (
                  <li key={h.record.id}>
                    <button onClick={() => select(h.record.id)} className={cn("flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent/60", selected === h.record.id && "bg-accent")}>
                      <div className="flex items-center gap-2">
                        <KnowledgeStatusBadge status={h.record.status} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{h.record.title}</span>
                        {h.score !== null ? <span className="text-[11px] tabular-nums text-muted-foreground">score {h.score.toFixed(2)}</span> : null}
                      </div>
                      <div className="flex gap-2 text-[11px] text-muted-foreground">
                        <span>{label(h.record.type)}</span>
                        <span>· {h.record.sourceActor.startsWith("agent:") ? (agents.get(h.record.sourceActor.slice(6)) ?? "agent") : h.record.sourceActor}</span>
                        <span>· {timeAgo(h.record.updatedAt)}</span>
                        {h.signals ? (
                          <span className="ml-auto">
                            {Object.entries(h.signals)
                              .filter(([k, v]) => v > 0 && !["trust", "recency"].includes(k))
                              .map(([k]) => k)
                              .join(" · ")}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
        <Card className="h-fit lg:sticky lg:top-16">
          <CardHeader title="Record" />
          <CardBody>{selected ? <DetailPanel key={selected} id={selected} agents={agents} onChanged={() => void mutate()} /> : <Empty title="Select a record" className="py-6" />}</CardBody>
        </Card>
      </div>
      {projectId ? <PublishDialog projectId={projectId} open={publishing} onClose={() => setPublishing(false)} onDone={() => void mutate()} /> : null}
    </>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Explorer />
    </Suspense>
  );
}
