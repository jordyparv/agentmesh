import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/**
 * Engine-side git invocations. Never runs repository hooks (core.hooksPath=/dev/null):
 * hooks are repository-controlled code and would otherwise execute unsandboxed on the host.
 */
const BASE = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.quotePath=false"];

export function git(cwd: string, args: string[], opts: { input?: string; allowFail?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...BASE, ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "AgentMesh",
          GIT_AUTHOR_EMAIL: "agentmesh@localhost",
          GIT_COMMITTER_NAME: "AgentMesh",
          GIT_COMMITTER_EMAIL: "agentmesh@localhost",
          LANG: "C",
        },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : 1) : 0;
        if (err && !opts.allowFail) {
          reject(new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || err.message}`, args, stderr, code));
          return;
        }
        resolve({ stdout, stderr, code });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function gitOut(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}
