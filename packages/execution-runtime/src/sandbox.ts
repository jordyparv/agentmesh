import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type SandboxKind = "bwrap" | "none";

export interface SandboxSpec {
  workdir: string;
  /** Whether the workdir is writable. */
  writable: boolean;
  network: boolean;
  /** Extra read-only paths (e.g. git common dir, agent binary install dir). */
  readOnly?: string[];
  /** Extra writable paths (e.g. ~/.codex for provider session state). */
  readWrite?: string[];
}

export interface Sandbox {
  kind: SandboxKind;
  wrap(cmd: string, args: string[], spec: SandboxSpec): { cmd: string; args: string[] };
}

/**
 * Bubblewrap sandbox. The host filesystem is mounted read-only, then $HOME, /tmp and
 * /run are replaced by empty tmpfs so credentials, SSH keys, other repositories and the
 * AgentMesh data dir are invisible. Only explicitly listed paths are bound back in.
 * Git worktrees by themselves are not a security boundary; this is.
 */
export const bwrapSandbox: Sandbox = {
  kind: "bwrap",
  wrap(cmd, args, spec) {
    const home = os.homedir();
    const a: string[] = [
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/run",
      "--tmpfs",
      home,
      "--tmpfs",
      "/root",
    ];
    if (!spec.network) a.push("--unshare-net");
    // DNS resolution on systemd hosts needs the resolver stub under /run.
    if (spec.network) for (const p of ["/run/systemd/resolve"]) if (existsSync(p)) a.push("--ro-bind", p, p);
    for (const p of uniq(spec.readOnly ?? [])) if (existsSync(p)) a.push("--ro-bind", p, p);
    for (const p of uniq(spec.readWrite ?? [])) if (existsSync(p)) a.push("--bind", p, p);
    a.push(spec.writable ? "--bind" : "--ro-bind", spec.workdir, spec.workdir);
    a.push("--chdir", spec.workdir, "--", cmd, ...args);
    return { cmd: "bwrap", args: a };
  },
};

export const noSandbox: Sandbox = {
  kind: "none",
  wrap: (cmd, args) => ({ cmd, args }),
};

export function selectSandbox(kind: SandboxKind): Sandbox {
  if (kind === "none") return noSandbox;
  try {
    execFileSync("bwrap", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("AGENTMESH_SANDBOX=bwrap but bubblewrap is not installed. Install bubblewrap or explicitly set AGENTMESH_SANDBOX=none (unsafe).");
  }
  return bwrapSandbox;
}

/** Resolves a command on PATH to its real install directory so it can be bound read-only into the sandbox. */
export function resolveBinary(cmd: string, pathEnv = process.env.PATH ?? ""): { path: string; realDir: string } | null {
  const candidates = cmd.includes("/") ? [cmd] : pathEnv.split(":").filter(Boolean).map((d) => path.join(d, cmd));
  for (const c of candidates) {
    if (existsSync(c)) {
      const real = realpathSync(c);
      return { path: c, realDir: path.dirname(real) };
    }
  }
  return null;
}

/** For a worktree, the shared .git directory of the parent repo (needed read-only for git to work). */
export function gitCommonDir(worktree: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const uniq = (xs: string[]) => [...new Set(xs)];
