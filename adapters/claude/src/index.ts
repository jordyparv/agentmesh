import os from "node:os";
import path from "node:path";
import type { AdapterFactory, AgentAdapter, AgentCapabilities, ExecutionRequest, ExecutionResult } from "@agentmesh/contracts";
import { classifyProviderError, linkedAbort, num, obj, parseJsonLine, resolveBinary, runProcess, str } from "@agentmesh/execution-runtime";

/**
 * Claude Code via its supported headless interface: `claude -p --output-format stream-json`.
 * Verified against Claude Code 2.1.319 (see docs/ai/IMPLEMENTATION_STATUS.md).
 */
export interface ClaudeConfig {
  binary?: string;
  model?: string;
  /** Allow the Bash tool for code-modifying tasks (runs inside the AgentMesh sandbox). */
  allowBash?: boolean;
  maxTurns?: number;
}

const READ_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

export function buildClaudeArgs(req: Pick<ExecutionRequest, "sandbox" | "outputSchema" | "mcp">, cfg: ClaudeConfig): string[] {
  const writable = req.sandbox === "workspace-write";
  const allowed = [...READ_TOOLS, ...(writable ? WRITE_TOOLS : []), ...(writable && cfg.allowBash !== false ? ["Bash"] : []), ...(req.mcp ? [`mcp__${req.mcp.name}`] : [])];
  const denied = writable ? (cfg.allowBash === false ? ["Bash"] : []) : [...WRITE_TOOLS, "Bash"];
  // WebFetch/WebSearch are denied: retrieved web content is a prompt-injection vector.
  denied.push("WebFetch", "WebSearch");
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    writable ? "acceptEdits" : "default",
    "--allowedTools",
    ...allowed,
    "--disallowedTools",
    ...denied,
  ];
  // Only the AgentMesh MCP server is loaded; user/project MCP configs are ignored (--strict-mcp-config).
  const mcpServers = req.mcp ? { [req.mcp.name]: { type: "stdio", command: req.mcp.command, args: req.mcp.args, env: req.mcp.env } } : {};
  args.push("--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config");
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.maxTurns) args.push("--max-turns", String(cfg.maxTurns));
  if (req.outputSchema) args.push("--json-schema", JSON.stringify(req.outputSchema));
  return args;
}

class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude";
  private running = new Map<string, AbortController>();
  constructor(
    readonly id: string,
    private cfg: ClaudeConfig,
  ) {}

  private bin() {
    return this.cfg.binary ?? "claude";
  }

  async probe(): Promise<AgentCapabilities> {
    const found = resolveBinary(this.bin());
    if (!found) return unavailable(`claude binary "${this.bin()}" not found on PATH`);
    const r = await runProcess({ cmd: found.path, args: ["--version"], cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "", HOME: os.homedir() }, timeoutMs: 15_000 });
    if (r.exitCode !== 0) return unavailable(`claude --version failed: ${r.stderr.trim() || r.spawnError || r.exitCode}`);
    return {
      available: true,
      version: r.stdout.trim().split(/\s+/)[0] ?? r.stdout.trim(),
      capabilities: ["plan", "architecture", "review", "implement", "debug", "refactor"],
      integrationMode: "automated",
      supportsStructuredOutput: true,
      supportsStreaming: true,
      detail: `claude -p --output-format stream-json (${found.path})`,
    };
  }

  async execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult> {
    const found = resolveBinary(this.bin(), req.env.PATH);
    if (!found) return { status: "failed", exitCode: null, summary: "", errorClass: "spawn_error", errorMessage: "claude binary not found", usage: {} };
    const { controller: ac, dispose } = linkedAbort(signal);
    this.running.set(req.runId, ac);

    const home = req.env.HOME ?? os.homedir();
    const wrapped = req.wrapCommand(found.path, buildClaudeArgs(req, this.cfg), {
      readOnly: [path.dirname(found.path), found.realDir],
      readWrite: [path.join(home, ".claude"), path.join(home, ".claude.json")],
    });

    let sessionId: string | undefined;
    let final: Record<string, unknown> | undefined;
    let lastText = "";
    const r = await runProcess({
      cmd: wrapped.cmd,
      args: wrapped.args,
      cwd: req.workdir,
      env: req.env,
      stdin: req.prompt,
      timeoutMs: req.timeoutMs,
      signal: ac.signal,
      onStdoutLine: (line) => {
        const ev = parseJsonLine(line);
        if (!ev) return req.onEvent({ type: "agent.raw", message: line.slice(0, 2000) });
        const type = str(ev.type);
        if (type === "system" && str(ev.subtype) === "init") {
          sessionId = str(ev.session_id);
          req.onEvent({ type: "agent.started", data: { sessionId, model: ev.model, tools: ev.tools } });
        } else if (type === "assistant" || type === "user") {
          const content = obj(ev.message)?.content;
          if (!Array.isArray(content)) return;
          for (const c of content as Record<string, unknown>[]) {
            const ct = str(c.type);
            if (ct === "text") {
              lastText = str(c.text) ?? "";
              req.onEvent({ type: "agent.message", message: lastText });
            } else if (ct === "thinking") {
              req.onEvent({ type: "agent.reasoning", message: str(c.thinking) ?? "" });
            } else if (ct === "tool_use") {
              req.onEvent({ type: "agent.tool_call", message: str(c.name), data: { input: truncateJson(c.input, 4000) } });
            } else if (ct === "tool_result") {
              req.onEvent({ type: "agent.tool_result", data: { isError: c.is_error === true, content: truncateJson(c.content, 4000) } });
            }
          }
        } else if (type === "result") {
          final = ev;
          const u = obj(ev.usage) ?? {};
          req.onEvent({ type: "agent.usage", data: { usage: u, costUsd: ev.total_cost_usd, numTurns: ev.num_turns } });
        }
      },
      onStderrLine: (line) => req.onEvent({ type: "agent.stderr", message: line.slice(0, 2000) }),
    });
    dispose();
    this.running.delete(req.runId);

    const u = obj(final?.usage) ?? {};
    const usage: ExecutionResult["usage"] = {
      inputTokens: (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0),
      cachedInputTokens: num(u.cache_read_input_tokens),
      outputTokens: num(u.output_tokens),
      costUsd: num(final?.total_cost_usd),
      durationMs: r.durationMs,
    };
    const summary = str(final?.result) ?? lastText;
    const base = { exitCode: r.exitCode, summary, usage, providerSessionId: sessionId };
    if (r.aborted) return { ...base, status: "cancelled", errorClass: "cancelled", errorMessage: "cancelled" };
    if (r.timedOut) return { ...base, status: "timed_out", errorClass: "timeout", errorMessage: `timed out after ${req.timeoutMs}ms` };
    if (r.spawnError) return { ...base, status: "failed", errorClass: "spawn_error", errorMessage: r.spawnError };
    if (!final || final.is_error === true || r.exitCode !== 0) {
      const msg = (final ? str(final.result) ?? str(final.subtype) : undefined) ?? (r.stderr.trim().slice(-2000) || `exit code ${r.exitCode}`);
      return { ...base, status: "failed", errorClass: final ? classifyProviderError(msg) : "nonzero_exit", errorMessage: msg };
    }
    if (req.outputSchema && final.structured_output === undefined) {
      return { ...base, status: "failed", errorClass: "invalid_output", errorMessage: "no structured_output in result" };
    }
    return { ...base, status: "succeeded", structuredOutput: final.structured_output };
  }

  async cancel(runId: string): Promise<void> {
    this.running.get(runId)?.abort();
  }
}

function unavailable(detail: string): AgentCapabilities {
  return { available: false, version: null, capabilities: [], integrationMode: "unavailable", supportsStructuredOutput: false, supportsStreaming: false, detail };
}
function truncateJson(v: unknown, n: number): unknown {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…[truncated]` : v;
}

export const claudeAdapterFactory: AdapterFactory = {
  kind: "claude",
  displayName: "Claude Code",
  create: (agent) => new ClaudeAdapter(agent.id, agent.config as ClaudeConfig),
};
