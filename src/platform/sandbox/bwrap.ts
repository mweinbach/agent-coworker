import fs from "node:fs";
import path from "node:path";

import {
  canonicalizeRoot,
  PROTECTED_SUBPATH_NAMES,
  type SandboxPolicy,
  withTmpScratch,
} from "./policy";

/**
 * Linux bubblewrap (`bwrap`) sandbox generation. Ported from OpenAI Codex
 * (`codex-rs/linux-sandbox/src/bwrap.rs`), keeping the filesystem + network
 * model and dropping the in-process seccomp layer (which requires native code).
 *
 * The filesystem starts read-only (`--ro-bind / /`); writable roots are layered
 * back on with `--bind`, and protected metadata subpaths (`.git`, `.cowork`)
 * are re-frozen read-only with `--ro-bind`. Network is removed with
 * `--unshare-net` unless the policy enables it.
 */

export const BWRAP_PROGRAM = "bwrap";

export interface BwrapCommand {
  file: string;
  args: string[];
}

export interface BuildBwrapOptions {
  /** Path to the `bwrap` executable (system or bundled). Defaults to `bwrap`. */
  program?: string;
  /** Existence predicate; injectable for deterministic tests. */
  exists?: (p: string) => boolean;
  /** Create a directory (recursively); injectable for deterministic tests. */
  ensureDir?: (p: string) => void;
  /** Create a file and its parent directory; injectable for deterministic tests. */
  ensureFile?: (p: string) => void;
  /** Directory predicate; injectable for deterministic tests. */
  isDirectory?: (p: string) => boolean;
}

/**
 * Build the full `bwrap` invocation that wraps `inner`. Returns
 * `{ file: "bwrap", args: [...flags, "--", inner.file, ...inner.args] }`.
 */
export function buildBwrapCommand(
  inner: BwrapCommand,
  policy: SandboxPolicy,
  cwd: string,
  opts: BuildBwrapOptions = {},
): BwrapCommand {
  const program = opts.program ?? BWRAP_PROGRAM;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const ensureDir =
    opts.ensureDir ??
    ((p: string) => {
      try {
        fs.mkdirSync(p, { recursive: true });
      } catch {
        // best effort: if we cannot create the root, it is skipped below
      }
    });
  const ensureFile =
    opts.ensureFile ??
    ((p: string) => {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.closeSync(fs.openSync(p, "a"));
      } catch {
        // best effort: if we cannot create the file root, it is skipped below
      }
    });
  const isDirectory =
    opts.isDirectory ??
    ((p: string) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        // Tests may provide virtual paths with a custom `exists` predicate. In
        // that case, assume directory so protected metadata carve-outs stay on.
        return true;
      }
    });

  const flags: string[] = ["--new-session", "--die-with-parent"];

  // 1. Read-only view of the whole filesystem + a minimal writable /dev.
  flags.push("--ro-bind", "/", "/", "--dev", "/dev");

  // 2. Layer writable roots back on. /tmp is added as scratch only when it would
  // not over-scope an explicit root under it. no-project-write has no explicit
  // roots, so only temp scratch is writable.
  if (policy.kind === "workspace-write" || policy.kind === "no-project-write") {
    const policyWritableRoots = policy.kind === "workspace-write" ? policy.writableRoots : [];
    const explicitRoots = new Set(policyWritableRoots.map(canonicalizeRoot));
    const rootKinds = policy.kind === "workspace-write" ? (policy.writableRootKinds ?? {}) : {};
    const explicitRootKinds = new Map(
      Object.entries(rootKinds).map(([root, kind]) => [canonicalizeRoot(root), kind]),
    );
    // Bind ancestor roots before descendants so a later parent bind cannot shadow
    // an earlier child's protected-metadata masks — e.g. binding /repo after
    // /repo/src would re-expose /repo/src/.git. Only ancestor/descendant pairs are
    // reordered; unrelated roots keep their input order (stable sort).
    const withScratch = withTmpScratch(policyWritableRoots, ["/tmp"]);
    const canonicalByRoot = new Map(withScratch.map((r) => [r, canonicalizeRoot(r)]));
    const writableRoots = withScratch.sort((a, b) => {
      const ca = canonicalByRoot.get(a) as string;
      const cb = canonicalByRoot.get(b) as string;
      if (cb.startsWith(`${ca}${path.sep}`)) return -1; // a is an ancestor of b
      if (ca.startsWith(`${cb}${path.sep}`)) return 1; // b is an ancestor of a
      return 0; // unrelated → preserve input order
    });

    for (const root of writableRoots) {
      // bwrap bind mount sources must exist. A child's assigned target may not
      // exist yet, so create a directory for dir-like roots and an empty file for
      // file-like roots. Otherwise Linux either drops the scope or creates a
      // directory where the child intended to create a file.
      if (!exists(root)) {
        const rootKind = explicitRootKinds.get(canonicalizeRoot(root));
        if (rootKind === "directory") ensureDir(root);
        else if (rootKind === "file" || looksLikeFilePath(root)) ensureFile(root);
        else ensureDir(root);
      }
      if (!exists(root)) continue; // creation failed; can't bind a missing source
      // Bind the canonical path so a symlinked root can't smuggle write access
      // to an unexpected target through a different logical path.
      const realRoot = canonicalizeRoot(root);
      flags.push("--bind", realRoot, realRoot);
      if (!isDirectory(realRoot)) continue;
      // Keep existing protected metadata read-only. Do not fabricate absent
      // `.git`/`.cowork` mountpoints under the host root: bwrap may create missing
      // destinations before mounting, which would mutate the user's workspace just
      // to set up the sandbox.
      const protectedDirs = new Set<string>();
      for (const name of PROTECTED_SUBPATH_NAMES) {
        const direct = path.join(realRoot, name);
        if (exists(direct)) protectedDirs.add(direct);
      }
      if (explicitRoots.has(realRoot)) {
        for (const dir of collectExistingProtectedMetadataDirs(realRoot, exists, isDirectory)) {
          protectedDirs.add(dir);
        }
      }
      for (const sub of [...protectedDirs].sort((left, right) => left.length - right.length)) {
        flags.push("--ro-bind", sub, sub);
      }
    }
  }

  // 3. Namespaces: fresh user/pid namespace + a clean /proc.
  flags.push("--unshare-user", "--unshare-pid", "--proc", "/proc");

  // 4. Network isolation unless explicitly enabled.
  const networkEnabled = policy.kind !== "danger-full-access" && policy.network;
  if (!networkEnabled) flags.push("--unshare-net");

  // 5. Enter the command's working directory inside the new mount view.
  flags.push("--chdir", path.resolve(cwd));

  flags.push("--", inner.file, ...inner.args);

  return { file: program, args: flags };
}

function looksLikeFilePath(p: string): boolean {
  const basename = path.basename(p);
  return path.extname(basename) !== "" || DOTLESS_FILE_BASENAMES.has(basename);
}

const DOTLESS_FILE_BASENAMES = new Set([
  "Brewfile",
  "Dockerfile",
  "Gemfile",
  "LICENSE",
  "Makefile",
  "NOTICE",
  "README",
]);

/**
 * Walk `root` and return every EXISTING `.git`/`.cowork` directory under it
 * (submodules, nested worktrees, …) so a backend can re-protect them. Symlinks
 * are not followed (see the loop), so a `vendor` -> `/` link can't make it
 * traverse out of the tree. Shared by the bwrap and Seatbelt backends.
 */
export function collectExistingProtectedMetadataDirs(
  root: string,
  exists: (p: string) => boolean,
  isDirectory: (p: string) => boolean,
): string[] {
  if (!exists(root) || !isDirectory(root)) return [];
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      // Never follow symlinks while scanning: a symlinked directory (e.g.
      // `vendor` -> `/`, or a self-referential link) would make the scan traverse
      // outside the root or loop forever before the command even starts. lstat
      // classifies the link itself, not its target, so symlinks are skipped.
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      if ((PROTECTED_SUBPATH_NAMES as readonly string[]).includes(entry)) {
        found.push(full);
        continue;
      }
      pending.push(full);
    }
  }
  return found;
}
