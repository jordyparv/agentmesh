"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { KnowledgeStatusBadge, RunStatusBadge } from "@/components/badges";
import { useProject } from "@/components/project-context";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ErrorState, Loading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Project, Run, SearchHit } from "@/lib/types";
import { duration, shortSha, timeAgo } from "@/lib/utils";

interface RepoInfo {
  defaultBranch: string;
  headSha: string;
  branches: string[];
  recentCommits: { sha: string; author: string; date: string; subject: string }[];
  fileCount: number;
  topLevel: string[];
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function Settings({ project, branches, onSaved }: { project: Project; branches: string[]; onSaved: () => void }) {
  const p = project.policy;
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.defaultBranch);
  const [instructions, setInstructions] = useState(project.instructions);
  const [requireApproval, setRequireApproval] = useState(p.requireApproval);
  const [validation, setValidation] = useState(p.validationCommands.join("\n"));
  const [allowed, setAllowed] = useState(p.defaultAllowedPaths.join("\n"));
  const [protectedPaths, setProtected] = useState(p.protectedPaths.join("\n"));
  const [maxAttempts, setMaxAttempts] = useState(p.maxAttempts);
  const [timeoutMin, setTimeoutMin] = useState(Math.round(p.defaultTimeoutMs / 60000));
  const [autoPlan, setAutoPlan] = useState(p.autoStartPlannedTasks);
  const [budget, setBudget] = useState(p.contextTokenBudget);
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`/projects/${project.id}`, {
        method: "PATCH",
        body: {
          name,
          defaultBranch: branch,
          instructions,
          policy: { requireApproval, validationCommands: lines(validation), defaultAllowedPaths: lines(allowed), protectedPaths: lines(protectedPaths), maxAttempts, defaultTimeoutMs: timeoutMin * 60000, autoStartPlannedTasks: autoPlan, contextTokenBudget: budget },
        },
      });
      toast("success", "Project saved");
      onSaved();
    } catch (x) {
      setErr(x);
    }
  };
  return (
    <form onSubmit={save} className="space-y-3" aria-label="Project settings">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="ps-name">
          <Input id="ps-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Default branch" htmlFor="ps-branch">
          <Select id="ps-branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
            {branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Project instructions" htmlFor="ps-instr">
        <Textarea id="ps-instr" rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
        <legend className="px-1 text-xs font-medium text-muted-foreground">Workflow policy (admin)</legend>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} /> Require human approval before integrating code changes
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={autoPlan} onChange={(e) => setAutoPlan(e.target.checked)} /> Auto-start tasks produced by planning agents
        </label>
        <Field label="Validation commands" htmlFor="ps-val" hint="Sandboxed quality gates; also re-run on the merge result.">
          <Textarea id="ps-val" rows={3} className="font-mono text-xs" value={validation} onChange={(e) => setValidation(e.target.value)} />
        </Field>
        <Field label="Default allowed paths" htmlFor="ps-allowed">
          <Textarea id="ps-allowed" rows={3} className="font-mono text-xs" value={allowed} onChange={(e) => setAllowed(e.target.value)} />
        </Field>
        <Field label="Protected paths (never modifiable)" htmlFor="ps-prot">
          <Textarea id="ps-prot" rows={3} className="font-mono text-xs" value={protectedPaths} onChange={(e) => setProtected(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Max attempts" htmlFor="ps-att">
            <Input id="ps-att" type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))} />
          </Field>
          <Field label="Timeout (min)" htmlFor="ps-to">
            <Input id="ps-to" type="number" min={1} max={240} value={timeoutMin} onChange={(e) => setTimeoutMin(Number(e.target.value))} />
          </Field>
          <Field label="Context tokens" htmlFor="ps-budget">
            <Input id="ps-budget" type="number" min={1000} max={200000} step={1000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
          </Field>
        </div>
      </fieldset>
      {err ? <ErrorState error={err} /> : null}
      <div className="flex justify-end">
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: project, error, mutate } = useApi<Project>(`/projects/${id}`);
  const { data: repo, error: repoErr } = useApi<RepoInfo>(`/projects/${id}/repository`);
  const { data: history } = useApi<{ run: Run; taskTitle: string; agentName: string }[]>(`/projects/${id}/history`);
  const { data: knowledge } = useApi<{ results: SearchHit[] }>(`/knowledge?projectId=${id}&limit=8`);
  const { reload, setProjectId } = useProject();
  useEffect(() => {
    setProjectId(id);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorState error={error} />;
  if (!project) return <Loading />;
  return (
    <div className="space-y-4">
      <div>
        <Link href="/projects" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="size-3" /> Projects
        </Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">{project.name}</h1>
        <p className="font-mono text-xs text-muted-foreground">{project.repoPath}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Settings" />
          <CardBody>
            {repo ? (
              <Settings
                project={project}
                branches={repo.branches}
                onSaved={() => {
                  void mutate();
                  reload();
                }}
              />
            ) : repoErr ? (
              <ErrorState error={repoErr} />
            ) : (
              <Loading />
            )}
          </CardBody>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Repository context" />
            <CardBody className="space-y-3 text-sm">
              {repo ? (
                <>
                  <p>
                    <span className="font-mono">{repo.defaultBranch}</span> @ <span className="font-mono">{shortSha(repo.headSha)}</span> · {repo.fileCount} files · {repo.branches.length} branches
                  </p>
                  <div className="flex flex-wrap gap-1 font-mono text-[11px] text-muted-foreground">
                    {repo.topLevel.map((t) => (
                      <span key={t} className="rounded border px-1">
                        {t}
                      </span>
                    ))}
                  </div>
                  <ul className="space-y-1">
                    {repo.recentCommits.map((c) => (
                      <li key={c.sha} className="flex gap-2 text-xs">
                        <span className="font-mono text-muted-foreground">{c.sha.slice(0, 7)}</span>
                        <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                        <span className="text-muted-foreground">{timeAgo(c.date)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Loading />
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Project knowledge" actions={<Link href="/knowledge" className="text-xs text-muted-foreground hover:underline">Explorer</Link>} />
            <CardBody className="space-y-1 text-sm">
              {knowledge?.results.length ? (
                knowledge.results.map((h) => (
                  <Link key={h.record.id} href={`/knowledge?record=${h.record.id}`} className="flex items-center gap-2 hover:underline">
                    <KnowledgeStatusBadge status={h.record.status} />
                    <span className="truncate">{h.record.title}</span>
                  </Link>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No knowledge yet.</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
      <Card>
        <CardHeader title="Execution history" />
        {history?.length ? (
          <ul className="divide-y text-sm">
            {history.map(({ run, taskTitle, agentName }) => (
              <li key={run.id} className="flex items-center gap-2 px-4 py-1.5">
                <RunStatusBadge status={run.status} />
                <Link href={`/tasks/${run.taskId}`} className="min-w-0 flex-1 truncate hover:underline">
                  {taskTitle}
                </Link>
                <span className="text-xs text-muted-foreground">{agentName}</span>
                <span className="w-16 text-right text-xs text-muted-foreground">{duration(run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null)}</span>
                <span className="w-16 text-right text-xs text-muted-foreground">{timeAgo(run.startedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">No runs yet.</p>
        )}
      </Card>
    </div>
  );
}
