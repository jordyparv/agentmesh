import type { Sandbox } from "@agentmesh/execution-runtime";
import { runProcess } from "@agentmesh/execution-runtime";
import { git } from "@agentmesh/workspace-manager";

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: Record<string, unknown>;
}

/**
 * Runs project-configured quality-gate commands inside the sandbox with networking
 * disabled. Commands come from project policy (set by an admin/operator), never from
 * agent output. Side effects of the commands on tracked files are reverted afterwards
 * so they cannot leak into the integrated result.
 */
export async function runCommandGates(opts: {
  dir: string;
  commands: string[];
  sandbox: Sandbox;
  env: Record<string, string>;
  timeoutMs: number;
  readOnly?: string[];
  signal?: AbortSignal;
}): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const command of opts.commands) {
    const wrapped = opts.sandbox.wrap("/bin/sh", ["-c", command], { workdir: opts.dir, writable: true, network: false, readOnly: opts.readOnly });
    const r = await runProcess({ cmd: wrapped.cmd, args: wrapped.args, cwd: opts.dir, env: opts.env, timeoutMs: opts.timeoutMs, signal: opts.signal, maxCapturedBytes: 64 * 1024 });
    const passed = r.exitCode === 0 && !r.timedOut && !r.aborted;
    results.push({
      gate: `command:${command}`,
      passed,
      detail: { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdout: r.stdout.slice(-16_000), stderr: r.stderr.slice(-16_000), spawnError: r.spawnError },
    });
    if (!passed) break; // fail fast; later gates would run against a known-bad tree
  }
  await git(opts.dir, ["checkout", "--", "."], { allowFail: true });
  await git(opts.dir, ["clean", "-fdq"], { allowFail: true });
  return results;
}
