import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { DomainError, notFound, WorkflowGraph, type WorkflowEdge, type WorkflowNode } from "@agentmesh/contracts";
import { agents, projects, workflowRuns, workflows, type Db } from "@agentmesh/database";
import { validateDag } from "./dag.ts";
import { audit, publishEvent } from "./events.ts";
import { modifiesCodeFor, type TaskRow, type TaskService } from "./tasks.ts";

export interface WorkflowIssue {
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
}

type TaskNode = Extract<WorkflowNode, { type: "task" }>;

/**
 * Compiled form of a workflow: for each task node, its nearest upstream task nodes (gates
 * and markers are collapsed) with the edge condition, plus the approval requirement.
 */
export interface CompiledWorkflow {
  order: string[];
  tasks: Map<string, { node: TaskNode; deps: { nodeId: string; condition: WorkflowEdge["condition"] }[]; requiresApproval: boolean }>;
}

/** Pure validation + compilation of a workflow graph into an executable task DAG. */
export function compileWorkflow(raw: unknown): { ok: true; compiled: CompiledWorkflow; issues: WorkflowIssue[] } | { ok: false; issues: WorkflowIssue[] } {
  const parsed = WorkflowGraph.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ severity: "error", message: `${i.path.join(".")}: ${i.message}` })) };
  const g = parsed.data;
  const issues: WorkflowIssue[] = [];
  const byId = new Map<string, WorkflowNode>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) issues.push({ severity: "error", message: `Duplicate node id ${n.id}`, nodeId: n.id });
    byId.set(n.id, n);
  }
  for (const e of g.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) issues.push({ severity: "error", message: `Edge ${e.id} references a missing node`, edgeId: e.id });
    if (e.source === e.target) issues.push({ severity: "error", message: `Edge ${e.id} is a self-loop`, edgeId: e.id });
    const src = byId.get(e.source);
    if (src && src.type !== "task" && e.condition !== "success") issues.push({ severity: "error", message: `Only task nodes can have failure/always branches (edge ${e.id})`, edgeId: e.id });
    if (byId.get(e.target)?.type === "start") issues.push({ severity: "error", message: `Start node cannot have incoming edges`, edgeId: e.id });
  }
  const seen = new Set<string>();
  for (const e of g.edges) {
    const k = `${e.source}->${e.target}`;
    if (seen.has(k)) issues.push({ severity: "error", message: `Duplicate edge ${k}`, edgeId: e.id });
    seen.add(k);
  }
  if (issues.some((i) => i.severity === "error")) return { ok: false, issues };
  const dag = validateDag(
    g.nodes.map((n) => n.id),
    g.edges.map((e) => ({ from: e.source, to: e.target })),
  );
  if (!dag.ok) return { ok: false, issues: [{ severity: "error", message: dag.error === "cycle" ? `Cycle: ${dag.cycle.join(" -> ")}` : `Invalid graph: ${dag.error}` }] };
  const taskNodes = g.nodes.filter((n): n is TaskNode => n.type === "task");
  if (!taskNodes.length) return { ok: false, issues: [{ severity: "error", message: "Workflow needs at least one task node" }] };

  const incoming = new Map<string, WorkflowEdge[]>();
  for (const e of g.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
  /** Nearest upstream task nodes, collapsing approval/start/end nodes. */
  const upstreamTasks = (id: string, visited = new Set<string>()): { nodeId: string; condition: WorkflowEdge["condition"] }[] => {
    const out: { nodeId: string; condition: WorkflowEdge["condition"] }[] = [];
    for (const e of incoming.get(id) ?? []) {
      if (visited.has(e.source)) continue;
      visited.add(e.source);
      const src = byId.get(e.source)!;
      if (src.type === "task") out.push({ nodeId: src.id, condition: e.condition });
      else out.push(...upstreamTasks(src.id, visited));
    }
    return out;
  };
  /** All task nodes transitively upstream of an approval node require human approval. */
  const gated = new Set<string>();
  const markUpstream = (id: string) => {
    for (const e of incoming.get(id) ?? []) {
      if (gated.has(e.source)) continue;
      gated.add(e.source);
      markUpstream(e.source);
    }
  };
  for (const n of g.nodes) if (n.type === "approval") {
    const before = gated.size;
    markUpstream(n.id);
    const gatedCode = [...gated].some((id) => {
      const t = byId.get(id);
      return t?.type === "task" && modifiesCodeFor(t.kind);
    });
    if (gated.size === before || !gatedCode) issues.push({ severity: "warning", message: `Approval node ${n.label} has no code-modifying task upstream`, nodeId: n.id });
  }
  const compiled: CompiledWorkflow = { order: dag.order.filter((id) => byId.get(id)!.type === "task"), tasks: new Map() };
  for (const n of taskNodes) {
    const deps = upstreamTasks(n.id);
    const dedup = [...new Map(deps.map((d) => [d.nodeId, d])).values()];
    compiled.tasks.set(n.id, { node: n, deps: dedup, requiresApproval: modifiesCodeFor(n.kind) && gated.has(n.id) });
    if (n.kind === "review" && !dedup.length) issues.push({ severity: "warning", message: `Review node ${n.label} has nothing upstream to review`, nodeId: n.id });
  }
  return { ok: true, compiled, issues };
}

const fill = (template: string, input: Record<string, string>) => template.replace(/\{\{\s*input\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) => input[k] ?? "");

export class WorkflowService {
  constructor(
    private db: Db,
    private tasks: TaskService,
  ) {}

  async list(projectId?: string) {
    const rows = await this.db
      .select()
      .from(workflows)
      .where(projectId ? or(eq(workflows.projectId, projectId), isNull(workflows.projectId)) : undefined)
      .orderBy(desc(workflows.isTemplate), workflows.name);
    return rows.map(toWorkflow);
  }

  async get(id: string) {
    const [w] = await this.db.select().from(workflows).where(eq(workflows.id, id));
    if (!w) throw notFound("Workflow", id);
    return toWorkflow(w);
  }

  /** Validates graph shape plus references (agents must exist and be capable of their node kind). */
  async validate(graph: unknown): Promise<{ ok: boolean; issues: WorkflowIssue[] }> {
    const c = compileWorkflow(graph);
    if (!c.ok) return c;
    const ids = [...c.compiled.tasks.values()].map((t) => t.node.agentId).filter((x): x is string => !!x);
    if (ids.length) {
      const found = new Set((await this.db.select({ id: agents.id }).from(agents).where(inArray(agents.id, ids))).map((a) => a.id));
      for (const t of c.compiled.tasks.values()) if (t.node.agentId && !found.has(t.node.agentId)) c.issues.push({ severity: "error", message: `Unknown agent on node ${t.node.label}`, nodeId: t.node.id });
    }
    return { ok: !c.issues.some((i) => i.severity === "error"), issues: c.issues };
  }

  async save(input: { id?: string; projectId: string | null; name: string; description: string; isTemplate: boolean; graph: unknown }, actor: string) {
    const v = await this.validate(input.graph);
    if (!v.ok) throw new DomainError("INVALID_WORKFLOW", "Workflow graph is not executable", 422, v.issues);
    const graph = WorkflowGraph.parse(input.graph) as unknown as Record<string, unknown>;
    if (input.id) {
      const cur = await this.get(input.id);
      const [u] = await this.db
        .update(workflows)
        .set({ name: input.name, description: input.description, isTemplate: input.isTemplate, graph, version: cur.version + 1, updatedAt: new Date() })
        .where(eq(workflows.id, input.id))
        .returning();
      await audit(this.db, { actor, action: "workflow.update", targetType: "workflow", targetId: input.id, detail: { version: u!.version } });
      return { workflow: toWorkflow(u!), issues: v.issues };
    }
    const [w] = await this.db.insert(workflows).values({ projectId: input.projectId, name: input.name, description: input.description, isTemplate: input.isTemplate, graph }).returning();
    await audit(this.db, { actor, action: "workflow.create", targetType: "workflow", targetId: w!.id, detail: { name: w!.name } });
    return { workflow: toWorkflow(w!), issues: v.issues };
  }

  async remove(id: string, actor: string) {
    await this.db.delete(workflows).where(eq(workflows.id, id));
    await audit(this.db, { actor, action: "workflow.delete", targetType: "workflow", targetId: id });
  }

  /** Materialises a workflow into tasks in one transaction (all or nothing). */
  async run(workflowId: string, projectId: string, input: Record<string, string>, autoStart: boolean, actor: string) {
    const wf = await this.get(workflowId);
    if (wf.projectId && wf.projectId !== projectId) throw new DomainError("WORKFLOW_PROJECT_MISMATCH", "Workflow belongs to another project", 422);
    const [project] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw notFound("Project", projectId);
    const c = compileWorkflow(wf.graph);
    if (!c.ok) throw new DomainError("INVALID_WORKFLOW", "Workflow graph is not executable", 422, c.issues);
    return this.db.transaction(async (tx) => {
      const [wr] = await tx.insert(workflowRuns).values({ workflowId, workflowVersion: wf.version, projectId, input, nodeTasks: {}, createdBy: actor }).returning();
      const nodeTasks: Record<string, string> = {};
      const created: TaskRow[] = [];
      for (const nodeId of c.compiled.order) {
        const t = c.compiled.tasks.get(nodeId)!;
        const n = t.node;
        const deps = t.deps.map((d) => ({ id: nodeTasks[d.nodeId]!, condition: d.condition }));
        const row = await this.tasks.create(
          {
            projectId,
            title: fill(n.label, input),
            description: fill(n.description || (n.kind === "plan" ? "Goal:\n{{input.goal}}" : "{{input.goal}}"), input),
            acceptanceCriteria: n.acceptanceCriteria.map((a) => fill(a, input)),
            kind: n.kind,
            requiredCapabilities: n.requiredCapabilities,
            priority: 50,
            assignedAgentId: n.agentId,
            dependsOn: deps.map((d) => d.id),
            allowedPaths: n.allowedPaths,
            timeoutMs: n.timeoutMs,
            maxAttempts: n.retry?.maxAttempts,
            autoStart,
          },
          actor,
          {
            tx,
            origin: "workflow",
            workflowRunId: wr!.id,
            workflowNodeId: n.id,
            conditions: Object.fromEntries(deps.map((d) => [d.id, d.condition])),
            idempotencyKey: `workflow:${wr!.id}:${n.id}`,
            ...(modifiesCodeFor(n.kind) ? { requiresApproval: t.requiresApproval || undefined } : {}),
          },
        );
        nodeTasks[n.id] = row.id;
        created.push(row);
      }
      await tx.update(workflowRuns).set({ nodeTasks }).where(eq(workflowRuns.id, wr!.id));
      await publishEvent(tx, { projectId, type: "workflow.started", payload: { workflowId, workflowRunId: wr!.id, nodeTasks, actor } });
      await audit(tx, { actor, action: "workflow.run", targetType: "workflow", targetId: workflowId, detail: { workflowRunId: wr!.id, projectId } });
      return { workflowRunId: wr!.id, nodeTasks, tasks: created };
    });
  }

  async runs(workflowId: string) {
    return this.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)).orderBy(desc(workflowRuns.createdAt)).limit(50);
  }

  /** Loads templates from workflows/<name>/workflow.json (idempotent by name). */
  async seedTemplates(dir: string): Promise<number> {
    let n = 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, "workflow.json");
      const raw = await readFile(file, "utf8").catch(() => null);
      if (!raw) continue;
      const def = JSON.parse(raw) as { name: string; description?: string; graph: unknown };
      const [existing] = await this.db.select().from(workflows).where(and(eq(workflows.name, def.name), eq(workflows.isTemplate, true), isNull(workflows.projectId)));
      const c = compileWorkflow(def.graph);
      if (!c.ok) throw new Error(`Template ${file} is invalid: ${JSON.stringify(c.issues)}`);
      const graph = WorkflowGraph.parse(def.graph) as unknown as Record<string, unknown>;
      if (existing) {
        if (JSON.stringify(existing.graph) !== JSON.stringify(graph)) await this.db.update(workflows).set({ graph, description: def.description ?? "", version: existing.version + 1, updatedAt: new Date() }).where(eq(workflows.id, existing.id));
      } else {
        await this.db.insert(workflows).values({ projectId: null, name: def.name, description: def.description ?? "", isTemplate: true, graph });
        n++;
      }
    }
    return n;
  }
}

function toWorkflow(w: typeof workflows.$inferSelect) {
  return { id: w.id, projectId: w.projectId, name: w.name, description: w.description, isTemplate: w.isTemplate, graph: w.graph as unknown as WorkflowGraph, version: w.version, createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString() };
}
