import { lstat, mkdir, readlink, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { DomainError } from "@agentmesh/contracts";
import { git, gitOut } from "./git.ts";

// ---------------------------------------------------------------- repository validation

export interface RepoInfo {
  repoPath: string;
  defaultBranch: string;
  headSha: string;
}

/**
 * Validates a user-supplied repository path: must be absolute, resolve (through symlinks)
 * to the top level of a non-bare git work tree, have at least one commit, and, when
 * `allowedRoots` is configured, live inside one of those roots.
 */
export async function validateRepository(input: string, opts: { allowedRoots?: string[]; forbiddenRoots?: string[] } = {}): Promise<RepoInfo> {
  if (!path.isAbsolute(input)) throw new DomainError("INVALID_REPO_PATH", "Repository path must be absolute");
  let real: string;
  try {
    real = await realpath(input);
  } catch {
    throw new DomainError("INVALID_REPO_PATH", `Path does not exist: ${input}`);
  }
  if (!(await stat(real)).isDirectory()) throw new DomainError("INVALID_REPO_PATH", "Path is not a directory");
  if (opts.allowedRoots?.length && !opts.allowedRoots.some((r) => isWithin(path.resolve(r), real))) {
    throw new DomainError("REPO_PATH_NOT_ALLOWED", `Repository must be inside one of: ${opts.allowedRoots.join(", ")}`, 403);
  }
  if (opts.forbiddenRoots?.some((r) => isWithin(path.resolve(r), real) || isWithin(real, path.resolve(r)))) {
    throw new DomainError("REPO_PATH_NOT_ALLOWED", "Repository path overlaps AgentMesh data directory", 403);
  }
  const top = await git(real, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) throw new DomainError("NOT_A_GIT_REPO", "Path is not a git repository");
  if (path.resolve(top.stdout.trim()) !== real) {
    throw new DomainError("NOT_REPO_ROOT", `Path is inside a repository; use its root: ${top.stdout.trim()}`);
  }
  const head = await git(real, ["rev-parse", "--verify", "HEAD"], { allowFail: true });
  if (head.code !== 0) throw new DomainError("EMPTY_REPO", "Repository has no commits");
  const branch = (await git(real, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })).stdout.trim();
  return { repoPath: real, defaultBranch: branch || "main", headSha: head.stdout.trim() };
}

export async function branchSha(repo: string, branch: string): Promise<string> {
  const r = await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { allowFail: true });
  if (r.code !== 0) throw new DomainError("BRANCH_NOT_FOUND", `Branch ${branch} not found`);
  return r.stdout.trim();
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------- worktrees

export interface Worktree {
  path: string;
  branch: string | null;
  baseSha: string;
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;

export class WorkspaceManager {
  constructor(private readonly worktreesRoot: string) {}

  /**
   * Allocates an isolated worktree for a task attempt. Code-modifying tasks get a
   * dedicated branch `agentmesh/<task8>-a<attempt>`; read-only tasks get a detached checkout.
   */
  async create(opts: { repo: string; projectId: string; taskId: string; attempt: number; baseRef: string; withBranch: boolean }): Promise<Worktree> {
    if (!SAFE_ID.test(opts.taskId) || !SAFE_ID.test(opts.projectId)) throw new Error("unsafe id");
    const baseSha = await gitOut(opts.repo, ["rev-parse", "--verify", `${opts.baseRef}^{commit}`]);
    const dir = path.join(this.worktreesRoot, opts.projectId, `${opts.taskId}-a${opts.attempt}`);
    await mkdir(path.dirname(dir), { recursive: true });
    await this.removeIfExists(opts.repo, dir);
    const branch = opts.withBranch ? `agentmesh/${opts.taskId.slice(0, 8)}-a${opts.attempt}` : null;
    if (branch) {
      await git(opts.repo, ["worktree", "add", "-B", branch, dir, baseSha]);
    } else {
      await git(opts.repo, ["worktree", "add", "--detach", dir, baseSha]);
    }
    return { path: dir, branch, baseSha };
  }

  async removeIfExists(repo: string, dir: string): Promise<void> {
    await git(repo, ["worktree", "remove", "--force", dir], { allowFail: true });
    await rm(dir, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"], { allowFail: true });
  }

  /**
   * Integrates `branch` into `target` without touching the user's working tree unless it is
   * the target's checkout and clean. Steps: merge in a throwaway integration worktree ->
   * run integration validation there -> atomically advance the target ref (compare-and-swap).
   */
  async integrate(opts: {
    repo: string;
    projectId: string;
    taskId: string;
    branch: string;
    target: string;
    validate: (dir: string) => Promise<{ passed: boolean; detail: unknown }>;
  }): Promise<IntegrationResult> {
    const targetSha = await branchSha(opts.repo, opts.target);
    const dir = path.join(this.worktreesRoot, opts.projectId, `${opts.taskId}-integration`);
    await mkdir(path.dirname(dir), { recursive: true });
    await this.removeIfExists(opts.repo, dir);
    await git(opts.repo, ["worktree", "add", "--detach", dir, targetSha]);
    try {
      const merge = await git(dir, ["merge", "--no-ff", "--no-edit", "-m", `AgentMesh: integrate ${opts.branch}`, opts.branch], { allowFail: true });
      if (merge.code !== 0) {
        const conflicts = (await gitOut(dir, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
        await git(dir, ["merge", "--abort"], { allowFail: true });
        return { ok: false, reason: "merge_conflict", conflicts, targetSha };
      }
      const mergeSha = await gitOut(dir, ["rev-parse", "HEAD"]);
      const v = await opts.validate(dir);
      if (!v.passed) return { ok: false, reason: "integration_validation_failed", detail: v.detail, targetSha, mergeSha };

      const checkout = await this.findCheckout(opts.repo, opts.target);
      if (checkout) {
        const dirty = (await gitOut(checkout, ["status", "--porcelain", "--untracked-files=no"])).length > 0;
        if (dirty) return { ok: false, reason: "target_checkout_dirty", detail: { checkout }, targetSha, mergeSha };
        const ff = await git(checkout, ["merge", "--ff-only", mergeSha], { allowFail: true });
        if (ff.code !== 0) return { ok: false, reason: "target_moved", detail: ff.stderr, targetSha, mergeSha };
      } else {
        const upd = await git(opts.repo, ["update-ref", `refs/heads/${opts.target}`, mergeSha, targetSha], { allowFail: true });
        if (upd.code !== 0) return { ok: false, reason: "target_moved", detail: upd.stderr, targetSha, mergeSha };
      }
      return { ok: true, mergeSha, targetSha };
    } finally {
      await this.removeIfExists(opts.repo, dir);
    }
  }

  /** Worktree path that has `branch` checked out, if any. */
  async findCheckout(repo: string, branch: string): Promise<string | null> {
    const out = await gitOut(repo, ["worktree", "list", "--porcelain"]);
    let current: string | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice(9);
      if (line === `branch refs/heads/${branch}` && current) return current;
    }
    return null;
  }
}

export type IntegrationResult =
  | { ok: true; mergeSha: string; targetSha: string }
  | { ok: false; reason: "merge_conflict" | "integration_validation_failed" | "target_checkout_dirty" | "target_moved"; conflicts?: string[]; detail?: unknown; targetSha: string; mergeSha?: string };

// ---------------------------------------------------------------- change inspection

export interface ChangedFile {
  path: string;
  status: string;
}

/** All changes in the worktree relative to baseSha, committed or not, including untracked files. */
export async function collectChanges(dir: string, baseSha: string): Promise<{ files: ChangedFile[]; diff: string }> {
  await git(dir, ["add", "-A"]);
  const raw = await gitOut(dir, ["diff", "--cached", "--name-status", "--no-renames", "-z", baseSha]);
  const parts = raw.split("\0").filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!, path: parts[i + 1]! });
  const diff = (await git(dir, ["diff", "--cached", "--no-color", baseSha])).stdout;
  return { files, diff };
}

export interface ScopeViolation {
  path: string;
  reason: "outside_allowed_paths" | "protected_path" | "symlink_escape" | "path_traversal";
  detail?: string;
}

/** Enforces task file scope. Runs on the engine side after the agent exits, before anything is committed or merged. */
export async function checkScope(dir: string, files: ChangedFile[], allowed: string[], protectedPaths: string[]): Promise<ScopeViolation[]> {
  const isAllowed = picomatch(allowed.length ? allowed : ["**"], { dot: true });
  const isProtected = protectedPaths.length ? picomatch(protectedPaths, { dot: true }) : () => false;
  const root = await realpath(dir);
  const violations: ScopeViolation[] = [];
  for (const f of files) {
    if (f.path.split("/").includes("..") || path.isAbsolute(f.path)) {
      violations.push({ path: f.path, reason: "path_traversal" });
      continue;
    }
    if (isProtected(f.path)) violations.push({ path: f.path, reason: "protected_path" });
    else if (!isAllowed(f.path)) violations.push({ path: f.path, reason: "outside_allowed_paths" });
    if (f.status !== "D") {
      const abs = path.join(root, f.path);
      const st = await lstat(abs).catch(() => null);
      if (st?.isSymbolicLink()) {
        const target = await readlink(abs);
        const resolved = path.resolve(path.dirname(abs), target);
        if (!isWithin(root, resolved)) violations.push({ path: f.path, reason: "symlink_escape", detail: target });
      }
    }
  }
  return violations;
}

export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ["add", "-A"]);
  const staged = await git(dir, ["diff", "--cached", "--quiet"], { allowFail: true });
  if (staged.code === 0) return null;
  await git(dir, ["commit", "--no-verify", "-q", "-m", message]);
  return gitOut(dir, ["rev-parse", "HEAD"]);
}
