"use client";
import { Copy, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProject } from "@/components/project-context";
import { PageHeader } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Workflow } from "@/lib/types";
import { timeAgo } from "@/lib/utils";

export default function WorkflowsPage() {
  const { projectId } = useProject();
  const { data, error, isLoading } = useApi<Workflow[]>(projectId ? `/workflows?projectId=${projectId}` : "/workflows");
  const router = useRouter();
  const toast = useToast();
  const clone = async (w: Workflow) => {
    try {
      const r = await api<{ workflow: Workflow }>("/workflows", { method: "POST", body: { projectId, name: `${w.name} (copy)`, description: w.description, isTemplate: false, graph: w.graph } });
      router.push(`/workflows/${r.workflow.id}`);
    } catch (e) {
      toast("danger", e instanceof Error ? e.message : String(e));
    }
  };
  const blank = async () => {
    try {
      const r = await api<{ workflow: Workflow }>("/workflows", {
        method: "POST",
        body: { projectId, name: "Untitled workflow", description: "", isTemplate: false, graph: { nodes: [{ id: "task1", type: "task", label: "{{input.goal}}", kind: "implement", position: { x: 0, y: 0 } }], edges: [] } },
      });
      router.push(`/workflows/${r.workflow.id}`);
    } catch (e) {
      toast("danger", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <PageHeader
        title="Workflows"
        description="Executable graphs of agent tasks, gates and approvals. Templates are read-only; clone one to edit."
        actions={
          <Button onClick={() => void blank()} disabled={!projectId}>
            <Plus /> New workflow
          </Button>
        }
      />
      {error ? <ErrorState error={error} /> : null}
      {isLoading ? <Loading /> : null}
      {data ? (
        <Card>
          {data.length ? (
            <ul className="divide-y">
              {data.map((w) => (
                <li key={w.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/workflows/${w.id}`} className="text-sm font-medium hover:underline">
                        {w.name}
                      </Link>
                      {w.isTemplate ? <Badge tone="info">template</Badge> : null}
                      <span className="text-xs text-muted-foreground">v{w.version}</span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{w.description || `${w.graph.nodes.length} nodes · ${w.graph.edges.length} edges`}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{timeAgo(w.updatedAt)}</span>
                  <Button size="sm" variant="outline" onClick={() => void clone(w)} disabled={!projectId}>
                    <Copy /> Clone
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No workflows">Run `pnpm agentmesh templates seed` to load the bundled templates.</Empty>
          )}
        </Card>
      ) : null}
    </>
  );
}
