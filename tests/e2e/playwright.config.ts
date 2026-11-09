import { defineConfig } from "@playwright/test";

const API = 4100;
const WEB = 3100;
const TOKEN = `am_${"e".repeat(48)}`;

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${WEB}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    {
      command: "npx tsx tests/e2e/stack.ts",
      cwd: "../..",
      url: `http://127.0.0.1:${API}/api/v1/health`,
      env: { E2E_API_PORT: String(API), AGENTMESH_SANDBOX: process.env.AGENTMESH_SANDBOX ?? "bwrap" },
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: `npx next start -H 127.0.0.1 -p ${WEB}`,
      cwd: "../../apps/web",
      url: `http://127.0.0.1:${WEB}/`,
      env: { AGENTMESH_API_URL: `http://127.0.0.1:${API}`, AGENTMESH_API_TOKEN: TOKEN, NEXT_TELEMETRY_DISABLED: "1" },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
