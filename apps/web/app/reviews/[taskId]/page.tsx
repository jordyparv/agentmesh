"use client";
import { ArrowLeft, CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import Link from "next/link";
import { use } from "react";
import { ApprovalActions } from "@/components/approval-actions";
import { TaskStatusBadge } from "@/components/badges";
import { DiffView } from "@/components/diff-view";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { useApi } from "@/lib/hooks";
import type { Run, Task, Validation } from "@/lib/types";
import { shortSha, timeAgo } from "@/lib/utils";

interface ReviewDetail {
  task: Task;
  project: { id: string; name: string; defaultBranch: string };
  run: Run | null;
  diff: string;
  changedFiles: { path: string; status: string }[];
  artifacts: { id: string; kind: string; name: string; sizeBytes: number }[];
  gates: Validation[];
  integrationGates: Validation[];
  reviews: { taskId: string; title: string; status: Task["status"]; agentName: string | null; verdict: string | null; summary: string | null; findings: { severity: string; file: string; message: string }[]; reviewedSha: string | null; current: boolean }[];
  mergePreview: { targetSha: string | null; clean: boolean; conflicts: string[]; error: string | null } | null;
  requirements: { humanApprovalRequired: boolean; integrationValidation: string[]; target: string; headSha: string | null; pendingReviews: number; blockingFindings: number };
  history: { id: string; decision: string; actor: string; comment: string; headSha: string | null; createdAt: string }[];
}

function Check({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
  const Icon = ok ? CheckCircle2 : warn ? CircleAlert : XCircle;
  return (
    <li className="flex items-center gap-2 text-sm">
      <Icon className={ok ? "size-4 text-success" : warn ? "size-4 text-warning" : "size-4 text-danger"} />
      {label}
    </li>
  );
}

export default function ReviewPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = use(params);
  const { data, error, mutate } = useApi<ReviewDetail>(`/reviews/${taskId}`, { refreshInterval: 5000 });
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const gatesOk = data.gates.length > 0 && data.gates.every((g) => g.passed);
  const awaiting = data.task.status === "AWAITING_APPROVAL";
  const warn =
    data.requirements.blockingFindings > 0
      ? "A reviewer requested changes."
      : data.requirements.pendingReviews > 0
        ? "Reviews are still running for this change."
        : data.mergePreview && !data.mergePreview.clean
          ? "The change no longer merges cleanly."
          : null;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/reviews" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="size-3" /> Review Center
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{data.task.title}</h1>
          <TaskStatusBadge status={data.task.status} />
          <Link href={`/tasks/${data.task.id}`} className="text-xs text-muted-foreground underline">
            task
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          {data.project.name} · <span className="font-mono">{data.task.branch}</span> @ <span className="font-mono">{shortSha(data.task.headSha)}</span> → <span className="font-mono">{data.project.defaultBranch}</span>
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Changes" description={`${data.changedFiles.length} files`} />
            <CardBody>
              <DiffView diff={data.diff} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Reviewer findings" description="From review tasks that inspected this exact change" />
            <CardBody className="space-y-3">
              {data.reviews.length ? (
                data.reviews.map((r) => (
                  <div key={r.taskId} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/tasks/${r.taskId}`} className="font-medium hover:underline">
                        {r.title}
                      </Link>
                      <TaskStatusBadge status={r.status} />
                      {r.verdict ? <Badge tone={r.verdict === "approve" ? "success" : "warning"}>{r.verdict.replace("_", " ")}</Badge> : null}
                      {!r.current && r.reviewedSha ? <Badge tone="warning">reviewed older commit {shortSha(r.reviewedSha)}</Badge> : null}
                      <span className="ml-auto text-xs text-muted-foreground">{r.agentName}</span>
                    </div>
                    {r.summary ? <p className="mt-1">{r.summary}</p> : null}
                    {r.findings.length ? (
                      <ul className="mt-2 space-y-1">
                        {r.findings.map((f, i) => (
                          <li key={i} className="flex gap-2 text-xs">
                            <Badge tone={f.severity === "critical" || f.severity === "major" ? "danger" : f.severity === "minor" ? "warning" : "neutral"}>{f.severity}</Badge>
                            <span className="font-mono">{f.file}</span>
                            <span>{f.message}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))
              ) : (
                <Empty title="No agent review" className="py-4">No review task depends on this change. Add one from the task board, or review the diff yourself.</Empty>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Test results and quality gates" />
            <CardBody>
              <ul className="space-y-1.5">
                {[...data.gates, ...data.integrationGates].map((g) => (
                  <li key={g.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <Badge tone={g.passed ? "success" : "danger"}>{g.passed ? "pass" : "fail"}</Badge>
                      <span className="font-mono text-xs">{g.gate}</span>
                      <Badge>{g.stage}</Badge>
                    </div>
                    {g.gate.startsWith("command:") ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">output</summary>
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(g.detail, null, 2)}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader title="Approval requirements" />
            <CardBody>
              <ul className="space-y-1.5" data-testid="requirements">
                <Check ok={gatesOk} label="Quality gates passed" />
                <Check ok={!!data.mergePreview?.clean} label={data.mergePreview?.clean ? `Merges cleanly into ${data.project.defaultBranch}` : `Merge conflicts: ${data.mergePreview?.conflicts.join(", ") || data.mergePreview?.error || "unknown"}`} />
                <Check ok={data.requirements.pendingReviews === 0} warn label={data.requirements.pendingReviews ? `${data.requirements.pendingReviews} review(s) still running` : "No pending reviews"} />
                <Check ok={data.requirements.blockingFindings === 0} warn label={data.requirements.blockingFindings ? "Changes requested by reviewer" : "No blocking findings"} />
                <Check ok warn label={data.requirements.integrationValidation.length ? `Re-validated after merge: ${data.requirements.integrationValidation.join("; ")}` : "No integration validation commands configured"} />
              </ul>
            </CardBody>
          </Card>
          {awaiting ? (
            <Card>
              <CardHeader title="Decision" />
              <CardBody>
                <ApprovalActions taskId={data.task.id} onDone={() => void mutate()} warn={warn} />
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="History" />
            <CardBody className="space-y-1 text-sm">
              {data.history.length ? (
                data.history.map((h) => (
                  <div key={h.id}>
                    <Badge tone={h.decision === "approved" ? "success" : h.decision === "rejected" ? "danger" : "warning"}>{h.decision.replace("_", " ")}</Badge> <span className="text-xs">{h.actor}</span> <span className="text-xs text-muted-foreground">{timeAgo(h.createdAt)}</span>
                    {h.comment ? <p className="text-xs text-muted-foreground">{h.comment}</p> : null}
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No decisions yet.</p>
              )}
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
