import fs from "node:fs";
import path from "node:path";

import { PROTECTED_SUBPATH_NAMES, type SandboxPolicy } from "./policy";

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

  const flags: string[] = ["--new-session", "--die-with-parent"];

  // 1. Read-only view of the whole filesystem + a minimal writable /dev.
  flags.push("--ro-bind", "/", "/", "--dev", "/dev");

  // 2. Layer writable roots back on (workspace-write only).
  if (policy.kind === "workspace-write") {
    const writableRoots = dedupe([...policy.writableRoots.map((r) => path.resolve(r)), "/tmp"]);

    for (const root of writableRoots) {
      // bwrap bind mount sources must exist. A child's assigned target dir may
      // not exist yet (e.g. `mkdir src/new-feature` is the first command), so
      // create it rather than dropping it — otherwise only /tmp stays writable
      // and the child can't work in its own scope (Linux/macOS parity).
      if (!exists(root)) ensureDir(root);
      if (!exists(root)) continue; // creation failed; can't bind a missing source
      // Bind the canonical path so a symlinked root can't smuggle write access
      // to an unexpected target through a different logical path.
      const realRoot = canonicalize(root);
      flags.push("--bind", realRoot, realRoot);
      // Keep protected metadata read-only. When the path is absent, mask it with
      // an unwritable empty tmpfs so a workspace-write command cannot *create*
      // `.git`/`.cowork` (and e.g. install git hooks) under the writable root.
      for (const name of PROTECTED_SUBPATH_NAMES) {
        const sub = path.join(realRoot, name);
        if (exists(sub)) {
          flags.push("--ro-bind", sub, sub);
        } else {
          flags.push("--perms", "555", "--tmpfs", sub, "--remount-ro", sub);
        }
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

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Resolve a path to its canonical (symlink-free) form; fall back to the input. */
function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
