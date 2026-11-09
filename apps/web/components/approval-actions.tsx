"use client";
import { Check, GitMerge, MessageSquareWarning, X } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/input";
import { ErrorState } from "./ui/states";
import { useToast } from "./ui/toast";
import { api } from "@/lib/api";

type Decision = "approved" | "rejected" | "changes_requested";

/** Approve (validated, controlled merge), reject, or request changes. The API enforces who may decide. */
export function ApprovalActions({ taskId, onDone, warn }: { taskId: string; onDone: () => void; warn?: string | null }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const decide = async (decision: Decision) => {
    if (decision !== "approved" && !comment.trim()) {
      setError(new Error("Add a comment explaining the decision."));
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      const r = await api<{ task: { status: string }; integration: { ok: boolean; reason?: string; mergeSha?: string } | null }>(`/approvals/${taskId}`, { method: "POST", body: { decision, comment } });
      if (decision === "approved") {
        if (r.integration?.ok) toast("success", `Integrated at ${r.integration.mergeSha?.slice(0, 10)}`);
        else toast("danger", `Integration failed: ${r.integration?.reason ?? "unknown"}`);
      } else toast("success", decision === "rejected" ? "Rejected" : "Changes requested; task re-queued");
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2" aria-label="Approval actions">
      {warn ? <p className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning">{warn}</p> : null}
      <Textarea rows={2} placeholder="Comment (required for reject / request changes)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Decision comment" />
      {error ? <ErrorState error={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="success" disabled={!!busy} onClick={() => void decide("approved")}>
          {busy === "approved" ? <GitMerge className="animate-pulse" /> : <Check />} Approve &amp; merge
        </Button>
        <Button variant="outline" disabled={!!busy} onClick={() => void decide("changes_requested")}>
          <MessageSquareWarning /> Request changes
        </Button>
        <Button variant="danger" disabled={!!busy} onClick={() => void decide("rejected")}>
          <X /> Reject
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Approval merges the exact validated commit in an isolated integration worktree, re-runs validation on the merge result, then advances the default branch atomically.</p>
    </div>
  );
}
