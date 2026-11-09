import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AdapterFactory, AgentAdapter, AgentCapabilities, Capability, ExecutionRequest, ExecutionResult } from "@agentmesh/contracts";
import { linkedAbort, parseJsonLine, runProcess, str } from "@agentmesh/execution-runtime";

/**
 * Controlled test adapter (SIMULATED provider). Spawns a real child process that follows
 * a scripted plan, so process handling, sandboxing, timeouts, cancellation, file-scope
 * enforcement and validation are exercised for real. Never used to claim a live
 * provider integration works.
 */
export type ScriptStep =
  | { write: { path: string; content: string } }
  | { symlink: { path: string; target: string } }
  | { message: string }
  | { sleepMs: number }
  | { exit: number; stderr?: string }
  | { output: unknown }
  | { tool: { name: string; args?: unknown; required?: boolean } };

export interface TestAdapterConfig {
  capabilities?: Capability[];
  /** Scripts by task kind, falling back to `default`. Prompt may override via a line `TEST_SCRIPT_KEY: <key>`. */
  scripts?: Record<string, ScriptStep[]>;
  unavailable?: boolean;
}

const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));

class TestAdapter implements AgentAdapter {
  readonly kind = "test";
  private running = new Map<string, AbortController>();
  constructor(
    readonly id: string,
    private cfg: TestAdapterConfig,
  ) {}

  async probe(): Promise<AgentCapabilities> {
    if (this.cfg.unavailable) return { available: false, version: null, capabilities: [], integrationMode: "unavailable", supportsStructuredOutput: false, supportsStreaming: false, detail: "configured unavailable" };
    return {
      available: true,
      version: "test-1",
      capabilities: this.cfg.capabilities ?? ["plan", "implement", "review", "test"],
      integrationMode: "automated",
      supportsStructuredOutput: true,
      supportsStreaming: true,
      detail: "SIMULATED controlled test adapter",
    };
  }

  async execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult> {
    const key = /^TEST_SCRIPT_KEY:\s*(\S+)/m.exec(req.prompt)?.[1] ?? /^Task kind:\s*(\S+)/m.exec(req.prompt)?.[1] ?? "default";
    const script = this.cfg.scripts?.[key] ?? this.cfg.scripts?.default ?? [{ message: "nothing to do" }];
    const { controller: ac, dispose } = linkedAbort(signal);
    this.running.set(req.runId, ac);
    const node = process.execPath;
    const wrapped = req.wrapCommand(node, [RUNNER], { readOnly: [path.dirname(node), path.dirname(RUNNER)] });
    let output: unknown;
    let last = "";
    const r = await runProcess({
      cmd: wrapped.cmd,
      args: wrapped.args,
      cwd: req.workdir,
      env: req.env,
      stdin: JSON.stringify(script),
      timeoutMs: req.timeoutMs,
      signal: ac.signal,
      killGraceMs: 500,
      onStdoutLine: (line) => {
        const ev = parseJsonLine(line);
        if (!ev) return;
        if (ev.type === "output") output = ev.value;
        else if (ev.type === "message") {
          last = str(ev.text) ?? "";
          req.onEvent({ type: "agent.message", message: last });
        } else if (ev.type === "file") req.onEvent({ type: "agent.file_change", data: { path: ev.path } });
      },
      onStderrLine: (l) => req.onEvent({ type: "agent.stderr", message: l }),
    });
    this.running.delete(req.runId);
    dispose();
    const base = { exitCode: r.exitCode, summary: output !== undefined ? JSON.stringify(output) : last, usage: { durationMs: r.durationMs } };
    if (r.aborted) return { ...base, status: "cancelled", errorClass: "cancelled", errorMessage: "cancelled" };
    if (r.timedOut) return { ...base, status: "timed_out", errorClass: "timeout", errorMessage: `timed out after ${req.timeoutMs}ms` };
    if (r.spawnError) return { ...base, status: "failed", errorClass: "spawn_error", errorMessage: r.spawnError };
    if (r.exitCode !== 0) return { ...base, status: "failed", errorClass: "nonzero_exit", errorMessage: r.stderr.trim() || `exit ${r.exitCode}` };
    if (req.outputSchema && output === undefined) return { ...base, status: "failed", errorClass: "invalid_output", errorMessage: "no structured output" };
    return { ...base, status: "succeeded", structuredOutput: output };
  }

  async cancel(runId: string): Promise<void> {
    this.running.get(runId)?.abort();
  }
}

export const testAdapterFactory: AdapterFactory = {
  kind: "test",
  displayName: "Test adapter (simulated)",
  create: (agent) => new TestAdapter(agent.id, agent.config as TestAdapterConfig),
};
