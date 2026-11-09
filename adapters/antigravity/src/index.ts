import os from "node:os";
import type { AdapterFactory, AgentAdapter, AgentCapabilities, ExecutionRequest, ExecutionResult } from "@agentmesh/contracts";
import { resolveBinary, runProcess } from "@agentmesh/execution-runtime";

/**
 * Google Antigravity CLI (`agy`). agy 1.5.2 exposes a headless print mode
 * (`-p --output-format stream-json --json-schema`) and an ACP stdio server, but its event
 * schema and sandbox behaviour have not been verified by AgentMesh yet. Until they are,
 * the adapter reports `assisted` and refuses unattended execution with an explicit
 * capability_unavailable result rather than guessing at the protocol. Deterministic
 * browser verification uses Playwright regardless (Phase 5).
 */
class AntigravityAdapter implements AgentAdapter {
  readonly kind = "antigravity";
  constructor(
    readonly id: string,
    private cfg: { binary?: string },
  ) {}

  async probe(): Promise<AgentCapabilities> {
    const bin = this.cfg.binary ?? "agy";
    const found = resolveBinary(bin);
    if (!found) {
      return { available: false, version: null, capabilities: [], integrationMode: "unavailable", supportsStructuredOutput: false, supportsStreaming: false, detail: `${bin} not found on PATH` };
    }
    const r = await runProcess({ cmd: found.path, args: ["--version"], cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "", HOME: os.homedir() }, timeoutMs: 15_000 });
    const version = r.exitCode === 0 ? r.stdout.trim() : null;
    return {
      available: r.exitCode === 0,
      version,
      capabilities: ["browser", "visual-qa"],
      integrationMode: "assisted",
      supportsStructuredOutput: false,
      supportsStreaming: false,
      detail: `${found.path}: headless mode detected but not yet verified by AgentMesh; tasks must be completed in assisted mode.`,
    };
  }

  async execute(_req: ExecutionRequest, _signal: AbortSignal): Promise<ExecutionResult> {
    return {
      status: "failed",
      exitCode: null,
      summary: "",
      errorClass: "capability_unavailable",
      errorMessage: "Unattended Antigravity execution is not verified yet (assisted mode only). See docs/ai/KNOWN_ISSUES.md.",
      usage: {},
    };
  }

  async cancel(): Promise<void> {}
}

export const antigravityAdapterFactory: AdapterFactory = {
  kind: "antigravity",
  displayName: "Google Antigravity",
  create: (agent) => new AntigravityAdapter(agent.id, agent.config as { binary?: string }),
};
