import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, selectSandbox, type SandboxKind } from "@agentmesh/execution-runtime";
import { codexAdapterFactory } from "@agentmesh/adapter-codex";
import { claudeAdapterFactory } from "@agentmesh/adapter-claude";
import { antigravityAdapterFactory } from "@agentmesh/adapter-antigravity";
import { testAdapterFactory } from "@agentmesh/adapter-test";
import type { EngineConfig } from "@agentmesh/engine-kernel";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface RuntimeConfig {
  databaseUrl: string;
  dataDir: string;
  apiHost: string;
  apiPort: number;
  /** URL agents (inside the sandbox) use to reach the API. */
  apiUrl: string;
  allowedRepoRoots: string[];
  sandbox: SandboxKind;
  enableTestAdapter: boolean;
  workerId: string;
}

/** Single place that reads environment variables (12-factor). */
export function loadConfig(env = process.env): RuntimeConfig {
  const apiHost = env.API_HOST ?? "127.0.0.1";
  const apiPort = Number(env.API_PORT ?? 4000);
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres",
    dataDir: path.resolve(REPO_ROOT, env.AGENTMESH_DATA_DIR ?? ".data"),
    apiHost,
    apiPort,
    apiUrl: env.AGENTMESH_API_URL ?? `http://${apiHost === "0.0.0.0" ? "127.0.0.1" : apiHost}:${apiPort}`,
    allowedRepoRoots: (env.AGENTMESH_ALLOWED_REPO_ROOTS ?? "").split(":").filter(Boolean).map((p) => path.resolve(p)),
    sandbox: (env.AGENTMESH_SANDBOX as SandboxKind | undefined) ?? "bwrap",
    // The simulated adapter is opt-in outside tests so it can't be mistaken for a real provider.
    enableTestAdapter: env.AGENTMESH_ENABLE_TEST_ADAPTER === "1",
    workerId: env.AGENTMESH_WORKER_ID ?? `worker-${process.pid}`,
  };
}

export function makeRegistry(opts: { enableTestAdapter: boolean }): AdapterRegistry {
  const r = new AdapterRegistry().register(codexAdapterFactory).register(claudeAdapterFactory).register(antigravityAdapterFactory);
  if (opts.enableTestAdapter) r.register(testAdapterFactory);
  return r;
}

export function engineConfig(c: RuntimeConfig, extra: Partial<EngineConfig> = {}): EngineConfig {
  return {
    dataDir: c.dataDir,
    workerId: c.workerId,
    leaseMs: 60_000,
    heartbeatMs: 10_000,
    sandbox: selectSandbox(c.sandbox),
    validationTimeoutMs: 10 * 60_000,
    apiUrl: c.apiUrl,
    ...extra,
  };
}
