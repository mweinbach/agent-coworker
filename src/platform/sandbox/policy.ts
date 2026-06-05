import fs from "node:fs";
import path from "node:path";

/**
 * High-level sandbox policy, modeled on OpenAI Codex's `SandboxPolicy`
 * (`codex-rs/protocol/src/protocol.rs`). This is the platform-agnostic
 * description of what a shell command is allowed to do; each platform module
 * (`seatbelt.ts`, `bwrap.ts`, `windows.ts`) translates it into a concrete
 * sandbox invocation.
 */
export type SandboxPolicy =
  | { kind: "danger-full-access" }
  | { kind: "read-only"; network: boolean }
  | {
      kind: "workspace-write";
      /** Absolute roots the sandboxed process may write to (beyond temp dirs). */
      writableRoots: string[];
      network: boolean;
    };

/** User/role-facing configuration mode. `auto` resolves from role + working dirs. */
export type SandboxMode = "auto" | "read-only" | "workspace-write" | "danger-full-access";

export interface SandboxConfig {
  mode: SandboxMode;
  /** Outbound network access inside the sandbox. Defaults to `true`. */
  network?: boolean;
  /**
   * When `true`, refuse to run a restrictive (read-only/workspace-write) command
   * if the platform sandbox backend is unavailable, instead of running it
   * unsandboxed with a warning. Defaults to `true` so the OS sandbox remains
   * the enforcement boundary unless the user explicitly opts out.
   */
  requireBackend?: boolean;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: "workspace-write",
  network: true,
  requireBackend: true,
};

/**
 * Metadata directory names that must remain read-only even when they live under
 * a writable root. Writing into `.git/hooks` or `.cowork` is a privilege
 * escalation vector, so these are carved back out of the writable set. Mirrors
 * Codex's `PROTECTED_METADATA_PATH_NAMES`.
 */
export const PROTECTED_SUBPATH_NAMES = [".git", ".cowork"] as const;

export interface ResolveSandboxPolicyInput {
  config?: SandboxConfig;
  /** Read-only role flag (explorer/research/reviewer). Forces read-only filesystem. */
  readOnlyRole?: boolean;
  workingDirectory: string;
  outputDirectory?: string;
  /** Child-agent enforced scope; when present these become the only writable roots. */
  targetPaths?: readonly string[] | null;
}

/**
 * Resolve a concrete {@link SandboxPolicy} from configuration, the agent role,
 * and the working directories. This is the single place that decides "what is
 * this command allowed to touch"; the OS sandbox then enforces it.
 */
export function resolveSandboxPolicy(input: ResolveSandboxPolicyInput): SandboxPolicy {
  const config = input.config ?? DEFAULT_SANDBOX_CONFIG;
  const network = config.network ?? true;

  // Read-only roles (explorer/reviewer/research) are a hard floor: they always
  // resolve to a read-only filesystem and are never escalated — even when the
  // configured mode is danger-full-access. This must be checked before the
  // danger-full-access short-circuit below.
  if (input.readOnlyRole || config.mode === "read-only") {
    return { kind: "read-only", network };
  }

  if (config.mode === "danger-full-access") {
    return { kind: "danger-full-access" };
  }

  // `workspace-write` and `auto` (for write-capable roles) both resolve here.
  return { kind: "workspace-write", writableRoots: deriveWritableRoots(input), network };
}

/**
 * Derive the absolute writable roots for a workspace-write policy. Child agents
 * with `targetPaths` are scoped strictly to those paths; otherwise the working
 * directory and output directory are writable.
 */
export function deriveWritableRoots(input: ResolveSandboxPolicyInput): string[] {
  const base = path.resolve(input.workingDirectory);
  if (input.targetPaths && input.targetPaths.length > 0) {
    return filterTargetPathsToWorkspace(base, input.targetPaths);
  }
  const roots = new Set<string>([base]);
  if (input.outputDirectory) roots.add(path.resolve(base, input.outputDirectory));
  return [...roots];
}

/**
 * Resolve child `targetPaths` to absolute writable roots, keeping only those
 * that stay WITHIN the workspace and outside its protected metadata.
 *
 * Relative entries (e.g. `["src/auth"]`) resolve against the workspace, not the
 * server process cwd. Absolute/escaping entries like `/home/user/.ssh` and
 * `.git`/`.cowork` paths are dropped — they must never become shell-writable
 * just because they were named as a target (the file tools already restrict to
 * the workspace, and the OS sandbox must not be looser).
 *
 * The result is empty when no entry is a usable scope; callers must reject such
 * a spawn rather than silently running a child that can write nowhere useful
 * (see `spawnAgent`).
 */
export function filterTargetPathsToWorkspace(
  workingDirectory: string,
  targetPaths: readonly string[],
): string[] {
  const base = path.resolve(workingDirectory);
  const realBase = canonicalizeRoot(base);
  const roots = new Set<string>();
  for (const p of targetPaths) {
    const real = resolveUsableTargetPath(base, realBase, p);
    if (real !== null) roots.add(real);
  }
  return [...roots];
}

/**
 * Whether `p` is a usable child scope: it stays within the workspace both
 * logically AND after resolving symlinks, and does not cross protected metadata
 * (`.git`/`.cowork`). Used to reject invalid child scopes at spawn time so the
 * stored targetPaths (consumed by both the OS sandbox and the built-in file
 * tools) are always valid.
 */
export function isUsableTargetPath(workingDirectory: string, p: string): boolean {
  const base = path.resolve(workingDirectory);
  return resolveUsableTargetPath(base, canonicalizeRoot(base), p) !== null;
}

/** Resolve `p` to its canonical writable root if it is a usable scope, else null. */
function resolveUsableTargetPath(base: string, realBase: string, p: string): string | null {
  const resolved = path.resolve(base, p);
  // Logical check first (cheap; also covers paths that don't exist yet).
  if (!isWithinWorkspace(base, resolved) || rootCrossesProtectedMetadata(base, resolved)) {
    return null;
  }
  // Then resolve symlinks and re-check: an in-workspace symlink whose real target
  // escapes the workspace (e.g. `src/link` -> `/home/user/secrets`) must not
  // become a writable root, or the OS sandbox would bind/allow the real target
  // outside scope. Return the canonical path so the backends bind/enforce it.
  const real = canonicalizeRoot(resolved);
  if (!isWithinWorkspace(realBase, real) || rootCrossesProtectedMetadata(realBase, real)) {
    return null;
  }
  return real;
}

/** Whether `root` is the workspace `base` or nested under it. */
function isWithinWorkspace(base: string, root: string): boolean {
  const relative = path.relative(base, root);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Whether `root`, expressed relative to the workspace `base`, passes through a
 * protected metadata directory (`.git`/`.cowork`). The check is relative so a
 * workspace that merely *lives under* a `.cowork` ancestor (e.g. a one-off chat
 * workspace under `~/.cowork/chats/<id>`) is not wrongly dropped.
 */
function rootCrossesProtectedMetadata(base: string, root: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(root));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(/[/\\]+/).filter(Boolean);
  return segments.some((seg) => (PROTECTED_SUBPATH_NAMES as readonly string[]).includes(seg));
}

/**
 * Add temp scratch dirs (e.g. `/tmp`) to a set of writable roots, but skip any
 * scratch dir that is an ancestor of an existing root. Otherwise a child scoped
 * to a target under `/tmp` (e.g. `/tmp/proj/src`) would get all of `/tmp` made
 * writable, defeating the scope.
 *
 * The ancestor check runs on macOS-canonical paths so the `/tmp` → `/private/tmp`
 * symlink can't sneak a blanket scratch root back in: a `/tmp/proj/src`-scoped
 * child must not get `/private/tmp` (the same tree) as writable scratch. The
 * emitted root keeps its original spelling — only the comparison is normalized.
 */
export function withTmpScratch(writableRoots: string[], scratch: string[]): string[] {
  const resolved = writableRoots.map((r) => path.resolve(r));
  const canonicalRoots = resolved.map(canonicalTmpAlias);
  const extra = scratch.filter((s) => {
    const cs = canonicalTmpAlias(s);
    return !canonicalRoots.some((cr) => cr === cs || cr.startsWith(`${cs}${path.sep}`));
  });
  return [...new Set([...resolved, ...extra])];
}

/** Resolve a path to its canonical (symlink-free) form; fall back to the input. */
export function canonicalizeRoot(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Normalize the well-known macOS firmlink aliases (`/tmp`, `/var` → `/private/*`)
 * for ancestor comparisons only. Applied symmetrically to both sides, so it is a
 * no-op on Linux (where the same prefix maps consistently) yet collapses the
 * macOS alias where `/tmp` and `/private/tmp` are the same directory.
 */
function canonicalTmpAlias(p: string): string {
  if (p === "/tmp" || p === "/var" || p.startsWith("/tmp/") || p.startsWith("/var/")) {
    return `/private${p}`;
  }
  return p;
}

/** Whether the policy permits outbound network access. */
export function policyAllowsNetwork(policy: SandboxPolicy): boolean {
  return policy.kind === "danger-full-access" || policy.network;
}
