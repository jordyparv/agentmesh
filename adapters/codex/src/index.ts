import { writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterFactory, AgentAdapter, AgentCapabilities, ExecutionRequest, ExecutionResult } from "@agentmesh/contracts";
import { classifyProviderError, linkedAbort, num, obj, parseJsonLine, resolveBinary, runProcess, str } from "@agentmesh/execution-runtime";

/**
 * OpenAI Codex via the supported non-interactive interface: `codex exec --json`.
 * Verified against codex-cli 0.167.0 (see docs/ai/IMPLEMENTATION_STATUS.md).
 */
export interface CodexConfig {
  binary?: string;
  model?: string;
  /** Codex's own sandbox inside the AgentMesh sandbox. Default follows the task's sandbox mode. */
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

const toml = (v: unknown) => JSON.stringify(v); // JSON strings/arrays are valid TOML values

export function buildCodexArgs(req: Pick<ExecutionRequest, "workdir" | "sandbox" | "mcp">, cfg: CodexConfig, files: { schema?: string; lastMessage: string }): string[] {
  const args = ["exec", "--json", "-C", req.workdir, "-s", cfg.codexSandbox ?? req.sandbox, "--skip-git-repo-check", "--ephemeral"];
  if (req.mcp) {
    const k = `mcp_servers.${req.mcp.name}`;
    args.push("-c", `${k}.command=${toml(req.mcp.command)}`, "-c", `${k}.args=${toml(req.mcp.args)}`);
    // `codex exec` runs with approval policy "never", which rejects MCP calls that need approval.
    // Auto-approve only the AgentMesh server: every call is authenticated, validated, scoped and
    // audited server-side. Valid values (codex 0.167): auto | prompt | writes | approve.
    args.push("-c", `${k}.default_tools_approval_mode="approve"`);
  }
  if (cfg.model) args.push("-m", cfg.model);
  if (files.schema) args.push("--output-schema", files.schema);
  args.push("-o", files.lastMessage, "-");
  return args;
}

class CodexAdapter implements AgentAdapter {
  readonly kind = "codex";
  private running = new Map<string, AbortController>();
  constructor(
    readonly id: string,
    private cfg: CodexConfig,
  ) {}

  private bin() {
    return this.cfg.binary ?? "codex";
  }

  async probe(): Promise<AgentCapabilities> {
    const found = resolveBinary(this.bin());
    if (!found) return unavailable(`codex binary "${this.bin()}" not found on PATH`);
    const r = await runProcess({ cmd: found.path, args: ["--version"], cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "", HOME: os.homedir() }, timeoutMs: 15_000 });
    if (r.exitCode !== 0) return unavailable(`codex --version failed: ${r.stderr.trim() || r.spawnError || r.exitCode}`);
    const version = r.stdout.trim().replace(/^codex-cli\s*/, "");
    return {
      available: true,
      version,
      capabilities: ["implement", "debug", "refactor", "test", "review"],
      integrationMode: "automated",
      supportsStructuredOutput: true,
      supportsStreaming: true,
      detail: `codex exec --json (${found.path})`,
    };
  }

  async execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult> {
    const found = resolveBinary(this.bin(), req.env.PATH);
    if (!found) return { status: "failed", exitCode: null, summary: "", errorClass: "spawn_error", errorMessage: "codex binary not found", usage: {} };
    const { controller: ac, dispose } = linkedAbort(signal);
    this.running.set(req.runId, ac);

    const lastMessage = path.join(req.scratchDir, "codex-last-message.txt");
    let schemaFile: string | undefined;
    if (req.outputSchema) {
      schemaFile = path.join(req.scratchDir, "output-schema.json");
      await writeFile(schemaFile, JSON.stringify(req.outputSchema));
    }
    const home = req.env.HOME ?? os.homedir();
    const wrapped = req.wrapCommand(found.path, buildCodexArgs(req, this.cfg, { schema: schemaFile, lastMessage }), {
      readOnly: [path.dirname(found.path), found.realDir],
      readWrite: [path.join(home, ".codex")],
    });

    let sessionId: string | undefined;
    let lastAgentMessage = "";
    let failure: string | undefined;
    const usage: ExecutionResult["usage"] = {};

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
        const item = obj(ev.item);
        if (type === "thread.started") {
          sessionId = str(ev.thread_id);
          req.onEvent({ type: "agent.started", data: { threadId: sessionId } });
        } else if (item && (type === "item.completed" || type === "item.started")) {
          const itype = str(item.type);
          if (itype === "agent_message" && type === "item.completed") {
            lastAgentMessage = str(item.text) ?? "";
            req.onEvent({ type: "agent.message", message: lastAgentMessage });
          } else if (itype === "reasoning" && type === "item.completed") {
            req.onEvent({ type: "agent.reasoning", message: str(item.text) ?? "" });
          } else if (itype === "command_execution") {
            req.onEvent({
              type: "agent.command",
              message: str(item.command),
              data: { status: item.status, exitCode: item.exit_code, output: type === "item.completed" ? truncate(str(item.aggregated_output) ?? "", 4000) : undefined },
            });
          } else if (itype === "file_change" && type === "item.completed") {
            req.onEvent({ type: "agent.file_change", data: { changes: item.changes } });
          } else if (itype === "mcp_tool_call" || itype === "web_search") {
            req.onEvent({ type: "agent.tool_call", message: itype, data: item });
          } else if (itype === "error") {
            req.onEvent({ type: "agent.error", message: str(item.message) });
          }
        } else if (type === "turn.completed") {
          const u = obj(ev.usage) ?? {};
          usage.inputTokens = (usage.inputTokens ?? 0) + (num(u.input_tokens) ?? 0);
          usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + (num(u.cached_input_tokens) ?? 0);
          usage.outputTokens = (usage.outputTokens ?? 0) + (num(u.output_tokens) ?? 0);
          req.onEvent({ type: "agent.usage", data: u });
        } else if (type === "turn.failed" || type === "error") {
          failure = str(obj(ev.error)?.message) ?? str(ev.message) ?? "codex reported an error";
          req.onEvent({ type: "agent.error", message: failure });
        }
      },
      onStderrLine: (line) => req.onEvent({ type: "agent.stderr", message: line.slice(0, 2000) }),
    });
    dispose();
    this.running.delete(req.runId);
    usage.durationMs = r.durationMs;

    const summary = (await readFile(lastMessage, "utf8").catch(() => "")).trim() || lastAgentMessage;
    const base = { exitCode: r.exitCode, summary, usage, providerSessionId: sessionId };
    if (r.aborted) return { ...base, status: "cancelled", errorClass: "cancelled", errorMessage: "cancelled" };
    if (r.timedOut) return { ...base, status: "timed_out", errorClass: "timeout", errorMessage: `timed out after ${req.timeoutMs}ms` };
    if (r.spawnError) return { ...base, status: "failed", errorClass: "spawn_error", errorMessage: r.spawnError };
    if (r.exitCode !== 0 || failure) {
      const msg = failure ?? (r.stderr.trim().slice(-2000) || `exit code ${r.exitCode}`);
      return { ...base, status: "failed", errorClass: failure ? classifyProviderError(msg) : "nonzero_exit", errorMessage: msg };
    }
    let structuredOutput: unknown;
    if (req.outputSchema) {
      try {
        structuredOutput = JSON.parse(summary);
      } catch {
        return { ...base, status: "failed", errorClass: "invalid_output", errorMessage: "final message was not valid JSON for the requested schema" };
      }
    }
    return { ...base, status: "succeeded", structuredOutput };
  }

  async cancel(runId: string): Promise<void> {
    this.running.get(runId)?.abort();
  }
}

function unavailable(detail: string): AgentCapabilities {
  return { available: false, version: null, capabilities: [], integrationMode: "unavailable", supportsStructuredOutput: false, supportsStreaming: false, detail };
}
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…[truncated]` : s);

export const codexAdapterFactory: AdapterFactory = {
  kind: "codex",
  displayName: "OpenAI Codex",
  create: (agent) => new CodexAdapter(agent.id, agent.config as CodexConfig),
};
