import fs from "node:fs/promises";
import path from "node:path";

import { home } from "../../platform/paths";
import { type ExecFileCompatRunner, execFileCompat } from "../../utils/execFileCompat";
import { isPathInside } from "../../utils/paths";

const PRIVATE_DIR_MODE = 0o700;
const DEFAULT_TIMEOUT_MS = 30_000;

export type ManagedWorktreeInput = {
  sourceCwd: string;
  ref?: string;
  branchName?: string;
  titleHint?: string;
};

export type ManagedWorktree = {
  path: string;
  repoRoot: string;
  branchName: string;
  baseRef: string;
  baseCommit: string;
};

export type WorktreeServiceDeps = {
  homedir?: string;
  execFile?: ExecFileCompatRunner;
};

function hashValue(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slugify(value: string | undefined, fallback: string): string {
  const slug =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^\.+/, "")
      .replace(/\.\.+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || fallback;
  return slug || fallback;
}

function assertSafeRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("Worktree ref must be non-empty");
  if (trimmed.startsWith("-")) throw new Error("Worktree ref must not start with '-'");
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      throw new Error("Worktree ref contains control characters");
    }
  }
  return trimmed;
}

function assertManagedPath(root: string, target: string): void {
  if (!isPathInside(root, target)) {
    throw new Error("Managed worktree path escaped ~/.cowork/worktrees");
  }
}

function formatGitFailure(args: string[], stderr: string, stdout: string): string {
  const detail = (stderr || stdout).trim();
  return detail ? `git ${args.join(" ")} failed: ${detail}` : `git ${args.join(" ")} failed`;
}

export function getManagedWorktreesRoot(homedir = home()): string {
  return path.join(homedir, ".cowork", "worktrees");
}

export class WorktreeService {
  private readonly execFile: ExecFileCompatRunner;

  constructor(private readonly deps: WorktreeServiceDeps = {}) {
    this.execFile = deps.execFile ?? execFileCompat;
  }

  async createWorktree(input: ManagedWorktreeInput): Promise<ManagedWorktree> {
    const sourceCwd = path.resolve(input.sourceCwd);
    const repoRoot = await this.resolveRepoRoot(sourceCwd);
    const baseRef = assertSafeRef(input.ref ?? "HEAD");
    const baseCommit = await this.resolveCommit(repoRoot, baseRef);
    const branchName = input.branchName?.trim()
      ? await this.validateBranchName(input.branchName)
      : this.generateBranchName(input.titleHint ?? path.basename(repoRoot));
    const root = getManagedWorktreesRoot(this.deps.homedir);
    await fs.mkdir(root, { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
      await fs.chmod(root, PRIVATE_DIR_MODE);
    } catch {
      // Best-effort hardening only.
    }

    const realRoot = await fs.realpath(root);
    const repoBucket = `${slugify(path.basename(repoRoot), "repo")}-${hashValue(repoRoot)}`;
    const worktreePath = path.join(
      realRoot,
      repoBucket,
      `${slugify(branchName, "fork")}-${hashValue(branchName).slice(0, 8)}`,
    );
    assertManagedPath(realRoot, worktreePath);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    await this.runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
    const realPath = await fs.realpath(worktreePath);
    assertManagedPath(realRoot, realPath);
    return { path: realPath, repoRoot, branchName, baseRef, baseCommit };
  }

  async resolveRepoRoot(cwd: string): Promise<string> {
    const result = await this.runGit(path.resolve(cwd), ["rev-parse", "--show-toplevel"]);
    return await fs.realpath(result.stdout.trim());
  }

  private async resolveCommit(repoRoot: string, ref: string): Promise<string> {
    const result = await this.runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return result.stdout.trim();
  }

  private async validateBranchName(raw: string): Promise<string> {
    const branchName = assertSafeRef(raw);
    await this.runGit(process.cwd(), ["check-ref-format", "--branch", branchName]);
    return branchName;
  }

  private generateBranchName(titleHint: string): string {
    const slug = slugify(titleHint, "thread").replace(/[._-]+$/g, "") || "thread";
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    return `cowork/fork/${slug}-${suffix}`;
  }

  private async runGit(cwd: string, args: string[]) {
    const result = await this.execFile("git", args, {
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new Error(formatGitFailure(args, result.stderr, result.stdout));
    }
    return result;
  }
}
