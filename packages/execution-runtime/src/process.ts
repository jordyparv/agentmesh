import { spawn } from "node:child_process";

export interface RunProcessOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  maxCapturedBytes?: number;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Runs a child process in its own process group so timeouts and cancellation kill the
 * whole tree (agents spawn shells, test runners, etc.). Output is streamed line-by-line
 * and a bounded tail is captured.
 */
export function runProcess(o: RunProcessOptions): Promise<RunProcessResult> {
  const started = Date.now();
  const cap = o.maxCapturedBytes ?? 256 * 1024;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    if (o.signal?.aborted) {
      resolve({ exitCode: null, signal: null, timedOut: false, aborted: true, stdout: "", stderr: "", durationMs: 0 });
      return;
    }

    const child = spawn(o.cmd, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const terminate = () => {
      killTree("SIGTERM");
      killTimer ??= setTimeout(() => killTree("SIGKILL"), o.killGraceMs ?? 5000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });

    const lineSplitter = (sink: ((l: string) => void) | undefined, append: (s: string) => void) => {
      let buf = "";
      return {
        push(chunk: Buffer) {
          const s = chunk.toString("utf8");
          append(s);
          if (!sink) return;
          buf += s;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line.length) sink(line);
          }
        },
        flush() {
          if (sink && buf.length) sink(buf);
          buf = "";
        },
      };
    };
    const out = lineSplitter(o.onStdoutLine, (s) => {
      stdout = (stdout + s).slice(-cap);
    });
    const err = lineSplitter(o.onStderrLine, (s) => {
      stderr = (stderr + s).slice(-cap);
    });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    child.stdin.end(o.stdin ?? "");

    const finish = (r: Partial<RunProcessResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      o.signal?.removeEventListener("abort", onAbort);
      out.flush();
      err.flush();
      resolve({ exitCode: null, signal: null, timedOut, aborted, stdout, stderr, durationMs: Date.now() - started, ...r });
    };
    child.on("error", (e) => finish({ spawnError: e.message }));
    child.on("close", (code, sig) => {
      // Make sure no orphaned grandchildren survive.
      killTree("SIGKILL");
      finish({ exitCode: code, signal: sig });
    });
  });
}

/**
 * Forwards `from` into a new AbortController, including when `from` is ALREADY aborted
 * (an "abort" listener never fires for a signal that aborted before it was attached).
 */
export function linkedAbort(from: AbortSignal): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (from.aborted) controller.abort();
  else from.addEventListener("abort", onAbort, { once: true });
  return { controller, dispose: () => from.removeEventListener("abort", onAbort) };
}
