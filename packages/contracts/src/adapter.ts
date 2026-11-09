/**
 * Provider-independent agent adapter contract. The engine kernel only ever
 * talks to agents through this interface; provider specifics live in adapters/*.
 */

export const CAPABILITIES = [
  "plan",
  "architecture",
  "implement",
  "debug",
  "refactor",
  "test",
  "review",
  "browser",
  "visual-qa",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type IntegrationMode = "automated" | "assisted" | "unavailable";

export interface AgentCapabilities {
  available: boolean;
  version: string | null;
  capabilities: Capability[];
  integrationMode: IntegrationMode;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  /** Human-readable detail: why unavailable, which binary was found, etc. */
  detail: string;
}

export type SandboxMode = "read-only" | "workspace-write";

export interface ExecutionRequest {
  runId: string;
  taskId: string;
  /** Absolute path of the isolated worktree the agent runs in. */
  workdir: string;
  /** Fully compiled prompt (context snapshot rendered to text). */
  prompt: string;
  sandbox: SandboxMode;
  timeoutMs: number;
  /** Optional JSON schema the agent's final answer must conform to. */
  outputSchema?: Record<string, unknown>;
  /** Provider-specific, non-secret configuration (model, effort, ...). */
  config: Record<string, unknown>;
  /** Environment for the agent process. Already filtered/allow-listed by the engine. */
  env: Record<string, string>;
  /** Writable directory outside the worktree for adapter temp files (schemas, output files). */
  scratchDir: string;
  /**
   * Engine-provided wrapper that sandboxes the process (bwrap) or passes through. Adapters
   * declare extra paths their CLI needs (install dir, provider state dir); everything else
   * in $HOME stays hidden.
   */
  wrapCommand: (
    cmd: string,
    args: string[],
    opts: { readOnly?: string[]; readWrite?: string[] },
  ) => { cmd: string; args: string[] };
  onEvent: (event: AgentEvent) => void;
  /**
   * AgentMesh MCP server for this run (collaboration tools), when the engine has an API to
   * talk to. Adapters register it with their CLI's MCP configuration mechanism.
   */
  mcp?: McpServerSpec;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type AgentEventType =
  | "agent.started"
  | "agent.message"
  | "agent.reasoning"
  | "agent.tool_call"
  | "agent.tool_result"
  | "agent.command"
  | "agent.file_change"
  | "agent.usage"
  | "agent.stderr"
  | "agent.raw"
  | "agent.error";

export interface AgentEvent {
  type: AgentEventType;
  message?: string;
  data?: Record<string, unknown>;
}

export type ErrorClass =
  | "timeout"
  | "cancelled"
  | "spawn_error"
  | "auth"
  | "rate_limit"
  | "provider_error"
  | "invalid_output"
  | "nonzero_exit"
  | "capability_unavailable";

export const RETRYABLE_ERRORS: readonly ErrorClass[] = ["timeout", "rate_limit", "provider_error", "nonzero_exit", "invalid_output"];

export interface ExecutionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface ExecutionResult {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  exitCode: number | null;
  /** Final natural-language answer from the agent. */
  summary: string;
  /** Parsed structured output when an outputSchema was requested and the agent complied. */
  structuredOutput?: unknown;
  errorClass?: ErrorClass;
  errorMessage?: string;
  usage: ExecutionUsage;
  /** Provider session/thread id, if any. */
  providerSessionId?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly kind: string;
  probe(): Promise<AgentCapabilities>;
  execute(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
  cancel(runId: string): Promise<void>;
}

export interface AdapterFactory {
  kind: string;
  displayName: string;
  create(agent: { id: string; config: Record<string, unknown> }): AgentAdapter;
}
