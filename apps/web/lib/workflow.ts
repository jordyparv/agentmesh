import type { Edge, Node } from "@xyflow/react";
import type { WorkflowGraph } from "./types";

/** Conversions between the executable WorkflowGraph contract and React Flow state. */
export type WfNodeData = Record<string, unknown> & {
  type: "task" | "approval" | "start" | "end";
  label: string;
  kind?: "plan" | "implement" | "review" | "test" | "generic";
  description?: string;
  requiredCapabilities?: string[];
  agentId?: string | null;
  allowedPaths?: string[];
  acceptanceCriteria?: string[];
  retry?: { maxAttempts: number };
  timeoutMs?: number;
  issue?: string;
};
export type WfNode = Node<WfNodeData, "wf">;
export type WfEdge = Edge<{ condition: "success" | "failure" | "always" }>;

export function toFlow(g: WorkflowGraph): { nodes: WfNode[]; edges: WfEdge[] } {
  return {
    nodes: g.nodes.map((n) => {
      const { id, position, ...rest } = n as WorkflowGraph["nodes"][number] & { position: { x: number; y: number } };
      return { id, type: "wf", position: position ?? { x: 0, y: 0 }, data: rest as WfNodeData };
    }),
    edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, data: { condition: e.condition ?? "success" }, label: e.condition && e.condition !== "success" ? `on ${e.condition}` : undefined })),
  };
}

export function fromFlow(nodes: WfNode[], edges: WfEdge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => {
      const { issue: _i, ...d } = n.data;
      const base = { id: n.id, label: d.label, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } };
      if (d.type !== "task") return { ...base, type: d.type } as WorkflowGraph["nodes"][number];
      return {
        ...base,
        type: "task",
        kind: d.kind ?? "implement",
        description: d.description ?? "",
        requiredCapabilities: d.requiredCapabilities ?? [],
        agentId: d.agentId ?? null,
        ...(d.allowedPaths?.length ? { allowedPaths: d.allowedPaths } : {}),
        acceptanceCriteria: d.acceptanceCriteria ?? [],
        ...(d.retry ? { retry: d.retry } : {}),
        ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
      } as WorkflowGraph["nodes"][number];
    }),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, condition: e.data?.condition ?? "success" })),
  };
}

export const NEXT_CONDITION = { success: "failure", failure: "always", always: "success" } as const;

export function newNodeId(nodes: { id: string }[], prefix: string): string {
  let i = 1;
  while (nodes.some((n) => n.id === `${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}
