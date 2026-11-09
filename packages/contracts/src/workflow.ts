import { z } from "zod";
import { CAPABILITIES } from "./adapter.ts";

/**
 * Executable workflow graph. The visual builder edits exactly this structure; the
 * workflow engine validates it and materialises it into a task DAG.
 *
 * - task: an agent task (kind decides read-only vs code-modifying).
 * - approval: a human gate. Every code-modifying task upstream of it requires human
 *   approval before integration; downstream nodes wait for that integration.
 * - start/end: optional markers, not materialised.
 *
 * Edges carry a condition: success (default), failure (run only if upstream failed),
 * always (run once upstream settles).
 */
export const WorkflowNode = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
    type: z.literal("task"),
    label: z.string().min(1).max(200),
    position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
    kind: z.enum(["plan", "implement", "review", "test", "generic"]),
    /** Supports {{input.goal}} style placeholders filled from the run input. */
    description: z.string().max(20_000).default(""),
    requiredCapabilities: z.array(z.enum(CAPABILITIES)).max(10).default([]),
    agentId: z.uuid().nullable().default(null),
    allowedPaths: z.array(z.string().min(1).max(300)).max(100).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(50).default([]),
    retry: z.object({ maxAttempts: z.number().int().min(1).max(10) }).optional(),
    timeoutMs: z.number().int().min(5_000).max(4 * 3600_000).optional(),
  }),
  z.object({
    id: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
    type: z.literal("approval"),
    label: z.string().min(1).max(200),
    position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  }),
  z.object({
    id: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
    type: z.enum(["start", "end"]),
    label: z.string().min(1).max(200),
    position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  }),
]);
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowEdge = z.object({
  id: z.string().min(1).max(130),
  source: z.string().min(1).max(60),
  target: z.string().min(1).max(60),
  condition: z.enum(["success", "failure", "always"]).default("success"),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

export const WorkflowGraph = z.object({
  nodes: z.array(WorkflowNode).min(1).max(100),
  edges: z.array(WorkflowEdge).max(400).default([]),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

export const CreateWorkflow = z.object({
  projectId: z.uuid().nullable().default(null),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(""),
  isTemplate: z.boolean().default(false),
  graph: WorkflowGraph,
});
export const UpdateWorkflow = CreateWorkflow.partial().omit({ projectId: true });

export const RunWorkflow = z.object({
  projectId: z.uuid(),
  input: z.object({ goal: z.string().min(1).max(20_000) }).catchall(z.string().max(20_000)),
  autoStart: z.boolean().default(true),
});
