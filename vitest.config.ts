import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "adapters/*/src/**/*.test.ts", "apps/{api,worker,cli}/src/**/*.test.ts", "tests/integration/**/*.test.ts", ...(process.env.AGENTMESH_LIVE ? ["tests/live/**/*.test.ts"] : [])],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
