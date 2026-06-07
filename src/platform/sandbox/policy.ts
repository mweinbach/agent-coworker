import path from "node:path";

import {
  canonicalizePathForBoundaryCheckSync,
  isPathInside,
  PROTECTED_METADATA_DIR_NAMES,
  pathCrossesProtectedMetadata,
} from "../../utils/paths";

/**
 * High-level sandbox policy, modeled on OpenAI Codex's `SandboxPolicy`
 * (`codex-rs/protocol/src/protocol.rs`). This is the platform-agnostic
 * description of what a shell command is allowed to do; each platform module
 * (`seatbelt.ts`, `bwrap.ts`, `windows.ts`) translates it into a concrete
 * sandbox invocation.
 */
export type SandboxPolicy =
  | { kind: "danger-full-access"; network?: boolean }
  | { kind: "read-only"; network: boolean }
  | { kind: "no-project-write"; network: boolean; projectRoots?: string[] }
  | {
      kind: "workspace-write";
      /** Absolute roots the sandboxed process may write to (beyond temp dirs). */
      writableRoots: string[];
      /** Optional creation hint for missing writable roots. */
      writableRootKinds?: Record<string, WritableRootKind>;
      network: boolean;
    };

export type WritableRootKind = "directory" | "file";

/** User/role-facing configuration mode. `auto` resolves from role + working dirs. */
export type SandboxMode = "auto" | "read-only" | "workspace-write" | "danger-full-access";

export interface SandboxConfig {
  mode: SandboxMode;
  /** Outbound network access inside the sandbox. Defaults to `true`. */
  network?: boolean;
  /**
   * When `true`, refuse to run a restrictive (read-only/workspace-write) command
   * if the platform sandbox backend is unavailable, instead of running it
   * unsandboxed after an approval. Defaults to `false` so a stock install still
   * works on hosts without a bundled sandbox backend; set to `true` to fail closed.
   */
  requireBackend?: boolean;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: "workspace-write",
  network: true,
  requireBackend: false,
};

/**
 * Metadata directory names that must remain read-only even when they live under
 * a writable root. Writing into `.git/hooks` or `.cowork` is a privilege
 * escalation vector, so these are carved back out of the writable set. Mirrors
 * Codex's `PROTECTED_METADATA_PATH_NAMES`. Shared with the built-in file tools
 * via `src/utils/paths.ts` so the sandbox and write/edit enforce the same set.
 */
export const PROTECTED_SUBPATH_NAMES = PROTECTED_METADATA_DIR_NAMES;

export interface ResolveSandboxPolicyInput {
  config?: SandboxConfig;
  /** Read-only role flag (explorer/research/reviewer). Forbids project writes. */
  readOnlyRole?: boolean;
  workingDirectory: string;
  /** Project root (parent of the .cowork dir); writable for file-tool parity. */
  projectRoot?: string;
  outputDirectory?: string;
  /** Uploads directory; writable for parity with the built-in file tools. */
  uploadsDirectory?: string;
  /** Cowork-managed runtime/cache roots that tool commands may mutate. */
  toolRuntimeWritableRoots?: readonly string[];
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

  // Explicit user-configured read-only stays fully immutable.
  if (config.mode === "read-only") {
    return { kind: "read-only", network };
  }

  // Read-only roles (explorer/reviewer/research) are a hard floor: they must not
  // write project files and are never escalated — even when the configured mode
  // is danger-full-access. They still get temp scratch space for verifier tools
  // that need to compile, diff, or stage transient files.
  if (input.readOnlyRole) {
    return { kind: "no-project-write", projectRoots: deriveProjectRoots(input), network };
  }

  // A scoped child (targetPaths) is constrained to its assigned paths even when
  // the workspace is configured danger-full-access: the explicit scope is a hard
  // floor, so it must not be lifted to unsandboxed full access (which would also
  // hand Codex-native shell/write tools the whole filesystem).
  const scoped = (input.targetPaths?.length ?? 0) > 0;
  if (config.mode === "danger-full-access" && !scoped) {
    return network === false
      ? { kind: "danger-full-access", network: false }
      : { kind: "danger-full-access" };
  }

  // `workspace-write` and `auto` (for write-capable roles) both resolve here, as
  // do scoped children under a danger-full-access config (held to their scope).
  return { kind: "workspace-write", ...deriveWritableRootInfo(input), network };
}

/**
 * Derive the absolute writable roots for a workspace-write policy. Child agents
 * with `targetPaths` are scoped strictly to those paths; otherwise the working
 * directory and output directory are writable.
 */
export function deriveWritableRoots(input: ResolveSandboxPolicyInput): string[] {
  return deriveWritableRootInfo(input).writableRoots;
}

function deriveWritableRootInfo(input: ResolveSandboxPolicyInput): {
  writableRoots: string[];
  writableRootKinds?: Record<string, WritableRootKind>;
} {
  const base = path.resolve(input.workingDirectory);
  if (input.targetPaths && input.targetPaths.length > 0) {
    const roots = new Set<string>();
    const rootKinds = new Map<string, WritableRootKind>();
    const containRoot = input.projectRoot ? path.resolve(input.projectRoot) : base;
    const realContainRoot = canonicalizeRoot(containRoot);
    for (const p of input.targetPaths) {
      const real = resolveUsableTargetPath(base, containRoot, realContainRoot, p);
      if (real === null) continue;
      roots.add(real);
      const kind = targetPathWritableRootKind(p);
      if (kind) rootKinds.set(real, kind);
    }
    const writableRoots = [...roots];
    const writableRootKinds = Object.fromEntries(
      writableRoots
        .filter((root) => rootKinds.has(root))
        .map((root) => [root, rootKinds.get(root) as WritableRootKind]),
    );
    return Object.keys(writableRootKinds).length > 0
      ? { writableRoots, writableRootKinds }
      : { writableRoots };
  }
  // Mirror the built-in file tools' write roots (project root + cwd + output +
  // uploads), plus Cowork-owned tool runtime caches, so unscoped workspace-write
  // bash can write the same locations as write/edit and maintain runtime deps
  // without forcing a full-access escalation.
  const candidates = [base];
  if (input.projectRoot) candidates.push(path.resolve(input.projectRoot));
  if (input.outputDirectory) candidates.push(path.resolve(base, input.outputDirectory));
  if (input.uploadsDirectory) candidates.push(path.resolve(base, input.uploadsDirectory));
  for (const root of input.toolRuntimeWritableRoots ?? []) {
    if (root.trim()) candidates.push(path.resolve(root));
  }
  // Canonicalize each root, then drop any inside protected metadata. The metadata
  // check is relative to the PROJECT root (the outermost writable boundary), not
  // just the working directory — otherwise an output/uploads/project root such as
  // `<repo>/.git/hooks` would look "outside" a subdirectory workingDirectory and
  // slip through the `.git`/`.cowork` carve-out. Canonicalizing first also stops a
  // symlinked dir (e.g. `uploads` -> `.git/hooks`) from sneaking metadata in.
  const reference = canonicalizeRoot(input.projectRoot ? path.resolve(input.projectRoot) : base);
  return {
    writableRoots: [
      ...new Set(
        candidates
          .map(canonicalizeRoot)
          .filter((root) => !rootCrossesProtectedMetadata(reference, root)),
      ),
    ],
  };
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
  projectRoot?: string,
): string[] {
  const resolveBase = path.resolve(workingDirectory);
  const containRoot = projectRoot ? path.resolve(projectRoot) : resolveBase;
  const realContainRoot = canonicalizeRoot(containRoot);
  const roots = new Set<string>();
  for (const p of targetPaths) {
    const real = resolveUsableTargetPath(resolveBase, containRoot, realContainRoot, p);
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
export function isUsableTargetPath(
  workingDirectory: string,
  p: string,
  projectRoot?: string,
): boolean {
  const resolveBase = path.resolve(workingDirectory);
  const containRoot = projectRoot ? path.resolve(projectRoot) : resolveBase;
  return (
    resolveUsableTargetPath(resolveBase, containRoot, canonicalizeRoot(containRoot), p) !== null
  );
}

/**
 * Resolve `p` (relative entries against `resolveBase`, the child's working
 * directory) to its canonical writable root if it is a usable scope, else null.
 * Containment and the protected-metadata check use `containRoot` (the project
 * root), so a child in a subdirectory workspace may still scope to project-root
 * files (e.g. `../package.json`) while escapes outside the project — and
 * `.git`/`.cowork` — are rejected.
 */
function resolveUsableTargetPath(
  resolveBase: string,
  containRoot: string,
  realContainRoot: string,
  p: string,
): string | null {
  const resolved = path.resolve(resolveBase, p);
  // Logical check first (cheap; also covers paths that don't exist yet).
  if (!isPathInside(containRoot, resolved) || rootCrossesProtectedMetadata(containRoot, resolved)) {
    return null;
  }
  // Then resolve symlinks and re-check: an in-workspace symlink whose real target
  // escapes (e.g. `src/link` -> `/home/user/secrets`) must not become a writable
  // root. Return the canonical path so the backends bind/enforce it.
  const real = canonicalizeRoot(resolved);
  if (!isPathInside(realContainRoot, real) || rootCrossesProtectedMetadata(realContainRoot, real)) {
    return null;
  }
  return real;
}

function targetPathWritableRootKind(p: string): WritableRootKind | undefined {
  return /[/\\]$/.test(p.trim()) ? "directory" : undefined;
}

/**
 * Whether `root`, expressed relative to the workspace `base`, passes through a
 * protected metadata directory (`.git`/`.cowork`). The check is relative so a
 * workspace that merely *lives under* a `.cowork` ancestor (e.g. a one-off chat
 * workspace under `~/.cowork/chats/<id>`) is not wrongly dropped.
 */
function rootCrossesProtectedMetadata(base: string, root: string): boolean {
  return pathCrossesProtectedMetadata(base, root);
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

export function tmpScratchRoots(blockedRoots: string[], scratch: string[]): string[] {
  const blocked = new Set(blockedRoots.map((root) => path.resolve(root)));
  return withTmpScratch(blockedRoots, scratch).filter((root) => !blocked.has(path.resolve(root)));
}

/**
 * Resolve a path to its canonical (symlink-free) form, canonicalizing the
 * longest EXISTING prefix and re-appending the missing tail. This matters for a
 * not-yet-created target below a symlinked parent (e.g. `src/link/new.ts` with
 * `src/link` -> elsewhere): realpath-ing only the full leaf would throw and fall
 * back to the unresolved in-workspace path, missing the escaping parent. Falls
 * back to the resolved logical path when nothing can be resolved.
 */
export function canonicalizeRoot(p: string): string {
  return canonicalizePathForBoundaryCheckSync(p);
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

function deriveProjectRoots(input: ResolveSandboxPolicyInput): string[] {
  return [
    ...new Set(
      [input.workingDirectory, input.projectRoot]
        .filter((root): root is string => typeof root === "string" && root.trim() !== "")
        .map((root) => path.resolve(root)),
    ),
  ];
}

/** Whether the policy permits outbound network access. */
export function policyAllowsNetwork(policy: SandboxPolicy): boolean {
  return policy.kind === "danger-full-access" ? policy.network !== false : policy.network;
}
