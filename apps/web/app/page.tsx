"use client";
import Link from "next/link";
import { HealthBadge, KnowledgeStatusBadge, RunStatusBadge } from "@/components/badges";
import { PageHeader } from "@/components/shell";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { Table, Td, Th } from "@/components/ui/table";
import { useApi } from "@/lib/hooks";
import { BOARD_COLUMNS } from "@/lib/status";
import type { Stats } from "@/lib/types";
import { cn, duration, timeAgo } from "@/lib/utils";

function Metric({ label, value, tone, href }: { label: string; value: string | number; tone?: "danger" | "warning" | "info"; href?: string }) {
  const body = (
    <div className="px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-semibold tabular-nums", tone === "danger" && "text-danger", tone === "warning" && "text-warning", tone === "info" && "text-info")}>{value}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="hover:bg-accent">
      {body}
    </Link>
  ) : (
    body
  );
}

export default function Dashboard() {
  const { data, error, isLoading } = useApi<Stats>("/stats", { refreshInterval: 5000 });
  return (
    <>
      <PageHeader title="Dashboard" description="Live state across all projects you can access." />
      {error ? <ErrorState error={error} className="mb-4" /> : null}
      {isLoading && !data ? <Loading /> : null}
      {data ? (
        <div className="space-y-4">
          <Card>
            <div className="grid grid-cols-2 divide-x sm:grid-cols-4 lg:grid-cols-8" data-testid="dashboard-metrics">
              <Metric label="Projects" value={data.projects.length} href="/projects" />
              <Metric label="Healthy agents" value={`${data.agents.filter((a) => a.health === "healthy").length}/${data.agents.length}`} href="/agents" />
              {BOARD_COLUMNS.filter((c) => ["backlog", "ready", "running", "blocked", "failed"].includes(c.key)).map((c) => (
                <Metric
                  key={c.key}
                  label={c.label}
                  value={data.tasks[c.key]}
                  tone={c.key === "failed" && data.tasks.failed ? "danger" : c.key === "blocked" && data.tasks.blocked ? "warning" : c.key === "running" && data.tasks.running ? "info" : undefined}
                  href="/tasks"
                />
              ))}
              <Metric label="Review queue" value={data.reviewQueue} tone={data.reviewQueue ? "warning" : undefined} href="/reviews" />
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="self-start lg:col-span-2">
              <CardHeader title="Execution history" description={`Last ${data.runs.windowDays} days · ${data.runs.total} runs`} />
              {data.runs.recent.length ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>Task</Th>
                      <Th>Agent</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Duration</Th>
                      <Th className="text-right">Tokens</Th>
                      <Th>Started</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.recent.map((r) => (
                      <tr key={r.id} className="hover:bg-accent/50">
                        <Td className="max-w-72 truncate">
                          <Link className="hover:underline" href={`/tasks/${r.taskId}`}>
                            {r.taskTitle}
                          </Link>
                        </Td>
                        <Td>{r.agentName}</Td>
                        <Td>
                          <RunStatusBadge status={r.status} />
                        </Td>
                        <Td className="text-right tabular-nums">{duration(r.durationMs)}</Td>
                        <Td className="text-right tabular-nums">{r.usage.inputTokens || r.usage.outputTokens ? ((r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0)).toLocaleString() : "—"}</Td>
                        <Td className="text-muted-foreground">{timeAgo(r.startedAt)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <Empty title="No runs yet">Create a task and start it to see execution history.</Empty>
              )}
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="Execution metrics" />
                <CardBody className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">Median duration</div>
                    <div className="font-medium tabular-nums">{duration(data.runs.durationMs.p50)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">p90 duration</div>
                    <div className="font-medium tabular-nums">{duration(data.runs.durationMs.p90)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Tokens in / out</div>
                    <div className="font-medium tabular-nums">
                      {data.runs.usage.inputTokens.toLocaleString()} / {data.runs.usage.outputTokens.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Reported cost</div>
                    <div className="font-medium tabular-nums">{data.runs.usage.costUsd ? `$${data.runs.usage.costUsd.toFixed(2)}` : "—"}</div>
                  </div>
                  <div className="col-span-2 flex flex-wrap gap-2">
                    {Object.entries(data.runs.outcomes).map(([k, v]) => (
                      <span key={k} className="inline-flex items-center gap-1 text-xs">
                        <RunStatusBadge status={k} /> {v}
                      </span>
                    ))}
                  </div>
                  <p className="col-span-2 text-[11px] text-muted-foreground">Cost appears only where the provider reports it (Claude Code reports cost; Codex reports tokens only).</p>
                </CardBody>
              </Card>
              <Card>
                <CardHeader
                  title="Agent health"
                  actions={
                    <Link href="/agents" className="text-xs text-muted-foreground hover:underline">
                      Manage
                    </Link>
                  }
                />
                {data.agents.length ? (
                  <ul className="divide-y">
                    {data.agents.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{a.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {a.kind} · {a.activeRuns ?? 0}/{a.maxConcurrency} active
                          </div>
                        </div>
                        <HealthBadge health={a.health} mode={a.integrationMode} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty
                    title="No agents registered"
                    action={
                      <Link href="/agents" className="text-xs underline">
                        Register an agent
                      </Link>
                    }
                  />
                )}
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader
              title="Recent knowledge discoveries"
              actions={
                <Link href="/knowledge" className="text-xs text-muted-foreground hover:underline">
                  Explorer
                </Link>
              }
            />
            {data.knowledge.length ? (
              <ul className="divide-y">
                {data.knowledge.map((k) => (
                  <li key={k.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <KnowledgeStatusBadge status={k.status} />
                    <Link href={`/knowledge?record=${k.id}`} className="min-w-0 flex-1 truncate hover:underline">
                      {k.title}
                    </Link>
                    <span className="hidden text-xs text-muted-foreground sm:inline">{k.type.replace(/_/g, " ")}</span>
                    <span className="w-20 text-right text-xs text-muted-foreground">{timeAgo(k.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No shared knowledge yet">Agents publish discoveries during runs; they appear here as provisional until verified.</Empty>
            )}
          </Card>
        </div>
      ) : null}
    </>
  );
}
