import { describe, expect, it } from "vitest";
import { runProcess } from "./process.ts";
import { buildAgentEnv } from "./env.ts";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("runProcess", () => {
  it("streams lines and captures exit code", async () => {
    const lines: string[] = [];
    const r = await runProcess({ cmd: "sh", args: ["-c", "echo one; echo two; exit 3"], cwd: "/", env, timeoutMs: 5000, onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(["one", "two"]);
    expect(r.exitCode).toBe(3);
  });
  it("enforces timeouts by killing the whole process group", async () => {
    const r = await runProcess({ cmd: "sh", args: ["-c", "sleep 30 & sleep 30; wait"], cwd: "/", env, timeoutMs: 300, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });
  it("aborts on signal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runProcess({ cmd: "sleep", args: ["30"], cwd: "/", env, timeoutMs: 10_000, signal: ac.signal, killGraceMs: 200 });
    expect(r.aborted).toBe(true);
  });
  it("reports spawn errors", async () => {
    const r = await runProcess({ cmd: "/nonexistent/binary", args: [], cwd: "/", env, timeoutMs: 1000 });
    expect(r.spawnError).toBeTruthy();
  });
});

describe("buildAgentEnv", () => {
  it("only passes allow-listed and explicitly granted variables", () => {
    const { env: e, missingSecrets } = buildAgentEnv({ source: { PATH: "/bin", DATABASE_URL: "postgres://x", OPENAI_API_KEY: "sk-1", AWS_SECRET_ACCESS_KEY: "a" }, secretEnv: ["OPENAI_API_KEY", "MISSING_ONE"] });
    expect(e.PATH).toBe("/bin");
    expect(e.OPENAI_API_KEY).toBe("sk-1");
    expect(e.DATABASE_URL).toBeUndefined();
    expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(missingSecrets).toEqual(["MISSING_ONE"]);
  });
});

describe("linkedAbort", () => {
  it("propagates an abort that happened before linking", async () => {
    const { linkedAbort } = await import("./process.ts");
    const src = new AbortController();
    src.abort();
    expect(linkedAbort(src.signal).controller.signal.aborted).toBe(true);
    const live = new AbortController();
    const l = linkedAbort(live.signal);
    expect(l.controller.signal.aborted).toBe(false);
    live.abort();
    expect(l.controller.signal.aborted).toBe(true);
  });
});
