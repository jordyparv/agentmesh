"use client";
import { FolderGit2, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useProject } from "@/components/project-context";
import { PageHeader } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";
import { timeAgo } from "@/lib/utils";

function RegisterForm({ onDone, onCancel }: { onDone: (p: Project) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [branch, setBranch] = useState("");
  const [instructions, setInstructions] = useState("");
  const [validation, setValidation] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const p = await api<Project>("/projects", {
        method: "POST",
        body: { name, repoPath, ...(branch ? { defaultBranch: branch } : {}), instructions, policy: { validationCommands: validation.split("\n").map((l) => l.trim()).filter(Boolean) } },
      });
      onDone(p);
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Register repository">
      <Field label="Name" htmlFor="pr-name">
        <Input id="pr-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Local repository path" htmlFor="pr-path" hint="Absolute path to the root of a git work tree with at least one commit. Symlinks are resolved; paths outside allowed roots are refused.">
        <Input id="pr-path" required className="font-mono text-xs" placeholder="/home/you/code/my-repo" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
      </Field>
      <Field label="Default branch" htmlFor="pr-branch" hint="Leave empty to use the repository's current branch.">
        <Input id="pr-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
      </Field>
      <Field label="Project instructions" htmlFor="pr-instr" hint="Given to every agent as instructions (human-authored).">
        <Textarea id="pr-instr" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      <Field label="Validation commands (one per line)" htmlFor="pr-val" hint="Run sandboxed, without network, as quality gates before review and again after merge.">
        <Textarea id="pr-val" rows={2} className="font-mono text-xs" placeholder="pnpm test" value={validation} onChange={(e) => setValidation(e.target.value)} />
      </Field>
      {err ? <ErrorState error={err} /> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Register
        </Button>
      </div>
    </form>
  );
}

export default function ProjectsPage() {
  const { projects, error, reload, setProjectId } = useProject();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Projects"
        description="Registered local Git repositories."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> Register repository
          </Button>
        }
      />
      {error ? <ErrorState error={error} /> : null}
      {!projects && !error ? <Loading /> : null}
      {projects ? (
        <Card>
          {projects.length ? (
            <ul className="divide-y">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                  <FolderGit2 className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/projects/${p.id}`} className="text-sm font-medium hover:underline">
                      {p.name}
                    </Link>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {p.repoPath} · {p.defaultBranch}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">{timeAgo(p.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No repositories registered" action={<Button size="sm" onClick={() => setOpen(true)}>Register repository</Button>} />
          )}
        </Card>
      ) : null}
      <Dialog open={open} onClose={() => setOpen(false)} title="Register repository">
        {open ? (
          <RegisterForm
            onCancel={() => setOpen(false)}
            onDone={(p) => {
              setOpen(false);
              reload();
              setProjectId(p.id);
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}
