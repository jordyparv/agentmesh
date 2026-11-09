"use client";
import { addEdge, Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, type Connection, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, CheckCircle2, Flag, Play, Plus, Save, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { CAPABILITIES } from "@agentmesh/contracts";
import { useProject } from "@/components/project-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ErrorState, Loading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Agent, Workflow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fromFlow, newNodeId, NEXT_CONDITION, toFlow, type WfEdge, type WfNode, type WfNodeData } from "@/lib/workflow";

interface Issue {
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
}

function WfNodeView({ data, selected }: NodeProps<WfNode>) {
  const t = data.type;
  return (
    <div
      className={cn(
        "min-w-44 max-w-60 rounded-md border bg-card px-3 py-2 text-xs shadow-sm",
        selected && "ring-2 ring-ring",
        t === "approval" && "border-warning/60",
        (t === "start" || t === "end") && "rounded-full bg-muted text-center",
        data.issue && "border-danger",
      )}
    >
      {t !== "start" ? <Handle type="target" position={Position.Top} /> : null}
      <div className="flex items-center gap-1.5">
        {t === "approval" ? <ShieldCheck className="size-3.5 text-warning" /> : t === "task" ? null : <Flag className="size-3.5 text-muted-foreground" />}
        <span className="truncate font-medium">{data.label}</span>
      </div>
      {t === "task" ? (
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge>{data.kind}</Badge>
          {(data.requiredCapabilities ?? []).slice(0, 3).map((c) => (
            <Badge key={c} tone="info">
              {c}
            </Badge>
          ))}
          {data.retry ? <Badge>×{data.retry.maxAttempts}</Badge> : null}
        </div>
      ) : null}
      {data.issue ? <div className="mt-1 text-[10px] text-danger">{data.issue}</div> : null}
      {t !== "end" ? <Handle type="source" position={Position.Bottom} /> : null}
    </div>
  );
}
const nodeTypes = { wf: WfNodeView };

function Inspector({ node, agents, readOnly, onChange, onDelete }: { node: WfNode; agents: Agent[]; readOnly: boolean; onChange: (d: Partial<WfNodeData>) => void; onDelete: () => void }) {
  const d = node.data;
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <div className="space-y-3">
      <Field label="Label" htmlFor="wi-label" hint={d.type === "task" ? "Supports {{input.goal}}" : undefined}>
        <Input id="wi-label" value={d.label} disabled={readOnly} onChange={(e) => onChange({ label: e.target.value })} />
      </Field>
      {d.type === "task" ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Kind" htmlFor="wi-kind">
              <Select id="wi-kind" value={d.kind} disabled={readOnly} onChange={(e) => onChange({ kind: e.target.value as WfNodeData["kind"] })}>
                {["plan", "implement", "review", "test", "generic"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            </Field>
            <Field label="Agent" htmlFor="wi-agent">
              <Select id="wi-agent" value={d.agentId ?? ""} disabled={readOnly} onChange={(e) => onChange({ agentId: e.target.value || null })}>
                <option value="">By capability</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Description" htmlFor="wi-desc">
            <Textarea id="wi-desc" rows={4} value={d.description ?? ""} disabled={readOnly} onChange={(e) => onChange({ description: e.target.value })} />
          </Field>
          <Field label="Required capabilities">
            <div className="flex flex-wrap gap-1">
              {CAPABILITIES.map((c) => (
                <label key={c} className="inline-flex items-center gap-1 rounded border px-1 text-[11px]">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={(d.requiredCapabilities ?? []).includes(c)}
                    onChange={(e) => onChange({ requiredCapabilities: e.target.checked ? [...(d.requiredCapabilities ?? []), c] : (d.requiredCapabilities ?? []).filter((x) => x !== c) })}
                  />
                  {c}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Allowed paths" htmlFor="wi-paths">
            <Textarea id="wi-paths" rows={2} className="font-mono text-xs" disabled={readOnly} value={(d.allowedPaths ?? []).join("\n")} onChange={(e) => onChange({ allowedPaths: lines(e.target.value) })} />
          </Field>
          <Field label="Acceptance criteria" htmlFor="wi-crit">
            <Textarea id="wi-crit" rows={2} disabled={readOnly} value={(d.acceptanceCriteria ?? []).join("\n")} onChange={(e) => onChange({ acceptanceCriteria: lines(e.target.value) })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Retry: max attempts" htmlFor="wi-retry">
              <Input id="wi-retry" type="number" min={1} max={10} disabled={readOnly} value={d.retry?.maxAttempts ?? ""} placeholder="policy" onChange={(e) => onChange({ retry: e.target.value ? { maxAttempts: Number(e.target.value) } : undefined })} />
            </Field>
            <Field label="Timeout (min)" htmlFor="wi-to">
              <Input id="wi-to" type="number" min={1} max={240} disabled={readOnly} value={d.timeoutMs ? d.timeoutMs / 60000 : ""} placeholder="policy" onChange={(e) => onChange({ timeoutMs: e.target.value ? Number(e.target.value) * 60000 : undefined })} />
            </Field>
          </div>
        </>
      ) : d.type === "approval" ? (
        <p className="text-xs text-muted-foreground">Every code-modifying task upstream of this node requires human approval before integration. Downstream nodes run after the approved change is integrated.</p>
      ) : (
        <p className="text-xs text-muted-foreground">Marker node; not executed.</p>
      )}
      {!readOnly ? (
        <Button variant="outline" size="sm" onClick={onDelete}>
          <Trash2 /> Delete node
        </Button>
      ) : null}
    </div>
  );
}

function Builder({ wf, onSaved }: { wf: Workflow; onSaved: (w: Workflow) => void }) {
  const initial = useMemo(() => toFlow(wf.graph), [wf]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WfNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WfEdge>(initial.edges);
  const [name, setName] = useState(wf.name);
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [goal, setGoal] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const { data: agents } = useApi<Agent[]>("/agents");
  const { projectId } = useProject();
  const toast = useToast();
  const router = useRouter();
  const readOnly = wf.isTemplate;
  const graph = useMemo(() => fromFlow(nodes, edges), [nodes, edges]);

  // Live server-side validation (same rules the engine applies when saving and running).
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ ok: boolean; issues: Issue[] }>("/workflows/validate", { method: "POST", body: { graph } })
        .then((r) => {
          setIssues(r.issues);
          setValid(r.ok);
        })
        .catch((e) => setErr(e));
    }, 400);
    return () => clearTimeout(t);
  }, [graph]);
  const issueByNode = useMemo(() => new Map((issues ?? []).filter((i) => i.nodeId && i.severity === "error").map((i) => [i.nodeId!, i.message])), [issues]);
  const shownNodes = useMemo(() => nodes.map((n) => (issueByNode.get(n.id) !== n.data.issue ? { ...n, data: { ...n.data, issue: issueByNode.get(n.id) } } : n)), [nodes, issueByNode]);

  const onConnect = useCallback((c: Connection) => !readOnly && setEdges((es) => addEdge({ ...c, id: `${c.source}-${c.target}`, data: { condition: "success" } }, es)), [readOnly, setEdges]);
  const add = (type: WfNodeData["type"]) => {
    const id = newNodeId(nodes, type === "task" ? "task" : type);
    const y = Math.max(0, ...nodes.map((n) => n.position.y)) + 110;
    setNodes((ns) => [...ns, { id, type: "wf", position: { x: 120, y }, data: type === "task" ? { type, label: "New task", kind: "implement", requiredCapabilities: [], acceptanceCriteria: [], agentId: null } : { type, label: type === "approval" ? "Human approval" : type } }]);
    setSelected(id);
  };
  const sel = nodes.find((n) => n.id === selected) ?? null;
  const save = async () => {
    setErr(null);
    try {
      const r = await api<{ workflow: Workflow }>(`/workflows/${wf.id}`, { method: "PUT", body: { name, graph } });
      toast("success", `Saved v${r.workflow.version}`);
      onSaved(r.workflow);
    } catch (e) {
      setErr(e);
    }
  };
  const run = async () => {
    setErr(null);
    try {
      const r = await api<{ tasks: { id: string }[] }>(`/workflows/${wf.id}/runs`, { method: "POST", body: { projectId, input: { goal }, autoStart: true } });
      toast("success", `Started workflow: ${r.tasks.length} tasks created`);
      setRunning(false);
      router.push("/tasks");
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/workflows" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="size-3" /> Workflows
        </Link>
        <Input aria-label="Workflow name" className="h-8 w-80 font-medium" value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
        {readOnly ? <Badge tone="info">template (read-only)</Badge> : null}
        <span className="text-xs text-muted-foreground">v{wf.version}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs" data-testid="wf-validity">
          {valid === null ? "validating…" : valid ? (
            <>
              <CheckCircle2 className="size-4 text-success" /> executable
            </>
          ) : (
            <>
              <TriangleAlert className="size-4 text-danger" /> not executable
            </>
          )}
        </span>
        {!readOnly ? (
          <>
            <Button variant="outline" size="sm" onClick={() => add("task")}>
              <Plus /> Task
            </Button>
            <Button variant="outline" size="sm" onClick={() => add("approval")}>
              <ShieldCheck /> Approval
            </Button>
            <Button variant="outline" size="sm" onClick={() => add("end")}>
              <Flag /> End
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!valid}>
              <Save /> Save
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="success" onClick={() => setRunning(true)} disabled={!valid || !projectId}>
          <Play /> Run
        </Button>
      </div>
      {err ? <ErrorState error={err} /> : null}
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className="h-[70vh] overflow-hidden rounded-lg border">
          <ReactFlow
            nodes={shownNodes}
            edges={edges.map((e) => ({ ...e, label: e.data?.condition && e.data.condition !== "success" ? `on ${e.data.condition}` : undefined, animated: e.data?.condition === "failure", style: e.data?.condition === "failure" ? { stroke: "var(--danger)" } : undefined }))}
            nodeTypes={nodeTypes}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            onEdgeClick={(_, e) => !readOnly && setEdges((es) => es.map((x) => (x.id === e.id ? { ...x, data: { condition: NEXT_CONDITION[x.data?.condition ?? "success"] } } : x)))}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
            fitView
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <div className="space-y-3">
          <Card>
            <CardHeader title={sel ? `Node: ${sel.id}` : "Inspector"} description={sel ? sel.data.type : "Select a node. Click an edge to cycle success → failure → always."} />
            <CardBody>
              {sel ? (
                <Inspector
                  key={sel.id}
                  node={sel}
                  agents={agents ?? []}
                  readOnly={readOnly}
                  onChange={(patch) => setNodes((ns) => ns.map((n) => (n.id === sel.id ? { ...n, data: { ...n.data, ...patch } } : n)))}
                  onDelete={() => {
                    setNodes((ns) => ns.filter((n) => n.id !== sel.id));
                    setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id));
                    setSelected(null);
                  }}
                />
              ) : (
                <p className="text-xs text-muted-foreground">Drag from a node&apos;s bottom handle to another node to add a dependency.</p>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Validation" />
            <CardBody className="space-y-1 text-xs">
              {issues?.length ? (
                issues.map((i, k) => (
                  <p key={k} className={i.severity === "error" ? "text-danger" : "text-warning"}>
                    {i.severity}: {i.message}
                  </p>
                ))
              ) : (
                <p className="text-muted-foreground">{issues ? "No issues." : "…"}</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
      <Dialog open={running} onClose={() => setRunning(false)} title={`Run: ${name}`} footer={<Button onClick={() => void run()} disabled={!goal.trim()}>Create tasks and start</Button>}>
        <Field label="Goal / feature request" htmlFor="wr-goal" hint="Fills {{input.goal}} in node labels and descriptions.">
          <Textarea id="wr-goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}

export default function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, mutate } = useApi<Workflow>(`/workflows/${id}`, { revalidateOnFocus: false });
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  return (
    <ReactFlowProvider>
      <Builder key={`${data.id}-${data.version}`} wf={data} onSaved={(w) => void mutate(w, { revalidate: false })} />
    </ReactFlowProvider>
  );
}
