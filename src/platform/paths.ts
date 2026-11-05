import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hostPlatform } from "./host";
import { pathImplForPlatform } from "./pathImpl";

/**
 * Metadata directory names that must stay read-only even inside a writable root.
 * Writing into `.git` (e.g. hooks) or `.cowork` (project config/skills/memory)
 * is a privilege-escalation vector, so both the shell sandbox policy and the
 * built-in write/edit file tools carve these back out of their writable roots.
 * Defined HERE (src/utils/paths.ts re-exports) so the deny-side fold logic and
 * the names it folds live in one module.
 */
export const PROTECTED_METADATA_DIR_NAMES = [".git", ".cowork"] as const;

export type CaseSensitivity = "sensitive" | "insensitive";

/**
 * Default filesystem case semantics per platform: win32 (NTFS) and darwin (default APFS)
 * are case-insensitive, everything else is case-sensitive. This is the DEFAULT for the
 * platform, not a probe of a specific volume — case-sensitive APFS and case-insensitive
 * ext4 mounts exist, which is why accept-side checks must not rely on this alone.
 */
export function fsCaseSensitivity(platform: NodeJS.Platform = hostPlatform()): CaseSensitivity {
  return platform === "win32" || platform === "darwin" ? "insensitive" : "sensitive";
}

function canonicalizeFromExistingAncestorSync(targetPath: string): string {
  const pendingSegments: string[] = [];
  let currentPath = path.resolve(targetPath);

  for (;;) {
    try {
      const canonicalExistingPath = fs.realpathSync.native(currentPath);
      return pendingSegments.length === 0
        ? canonicalExistingPath
        : path.join(canonicalExistingPath, ...pendingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return path.resolve(targetPath);
      }
      pendingSegments.push(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

/**
 * Canonicalize a path against the real filesystem: `fs.realpathSync.native` on the longest
 * existing prefix, with any not-yet-existing suffix re-appended lexically. On win32 this
 * resolves subst/mapped drives and on-disk casing, on darwin the /tmp → /private/tmp
 * firmlinks, on linux symlinks. All boundary checks must compare canonical forms from
 * this ONE engine so they string-match everywhere.
 */
export function canonicalizeSync(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return canonicalizeFromExistingAncestorSync(targetPath);
    }
    throw error;
  }
}

/**
 * Async facade over {@link canonicalizeSync}. It deliberately WRAPS the sync engine:
 * Bun 1.3 has no `fs.promises.realpath.native`, and mixing the JS realpath with the
 * native one produces canonical forms that do not string-match (e.g. 8.3 names, drive
 * casing) — so every caller, sync or async, goes through the single native sync engine.
 */
export async function canonicalize(targetPath: string): Promise<string> {
  return canonicalizeSync(targetPath);
}

function isRelativeOutsideRoot(rel: string, impl: typeof path.posix | typeof path.win32): boolean {
  return rel === ".." || rel.startsWith(`..${impl.sep}`) || impl.isAbsolute(rel);
}

/**
 * ACCEPT-side containment predicate (feeds sandbox writable roots and read/write allow
 * decisions), so it must fail CLOSED: both paths are canonicalized (symlinks, firmlinks,
 * on-disk casing for existing prefixes), then compared case-folded ONLY on win32. On
 * darwin the comparison is exact — case-sensitive APFS exists, and lexical folding there
 * would WIDEN the sandbox. Drive/UNC-root crossings on win32 are always outside.
 * Contrast with {@link crossesProtectedMetadata}, the DENY-side check, which does fold.
 */
export function isInside(
  parent: string,
  child: string,
  opts: {
    platform?: NodeJS.Platform;
    allowEqual?: boolean;
    /** Test seam: replace the real-filesystem canonicalizer (defaults to canonicalizeSync). */
    canonicalize?: (p: string) => string;
  } = {},
): boolean {
  const platform = opts.platform ?? hostPlatform();
  const allowEqual = opts.allowEqual ?? true;
  const canonicalizeFn = opts.canonicalize ?? canonicalizeSync;
  const impl = pathImplForPlatform(platform);
  const fold = platform === "win32" ? (p: string) => p.toLowerCase() : (p: string) => p;
  const rel = impl.relative(fold(canonicalizeFn(parent)), fold(canonicalizeFn(child)));
  if (rel === "") return allowEqual;
  return !isRelativeOutsideRoot(rel, impl);
}

/**
 * DENY-side check: does `target`, relative to `base`, pass through a protected metadata
 * directory (`.git`/`.cowork`)? Segments are case-folded on win32 AND darwin — over-blocking
 * on a case-sensitive APFS volume is safe, while missing `.GIT/hooks` on the default
 * case-insensitive volume is a privilege escalation. Resolve symlinks (canonicalize)
 * before calling; the check itself is purely lexical.
 */
export function crossesProtectedMetadata(
  base: string,
  target: string,
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  const impl =
    platform === "win32" || /^[A-Za-z]:[\\/]/.test(base) || /^[A-Za-z]:[\\/]/.test(target)
      ? pathImplForPlatform("win32")
      : pathImplForPlatform(platform);
  const rel = impl.relative(impl.resolve(base), impl.resolve(target));
  if (rel === "" || isRelativeOutsideRoot(rel, impl)) {
    return false;
  }
  const foldSegments = fsCaseSensitivity(platform) === "insensitive";
  const protectedNames = (PROTECTED_METADATA_DIR_NAMES as readonly string[]).map((name) =>
    foldSegments ? name.toLowerCase() : name,
  );
  return rel
    .split(/[/\\]+/)
    .filter(Boolean)
    .some((segment) => protectedNames.includes(foldSegments ? segment.toLowerCase() : segment));
}

/**
 * Relative path from `from` to `to`, always emitted with forward slashes regardless of
 * platform — the one implementation of the `split(sep).join("/")` idiom for
 * config/manifest/wire formats that must be byte-identical across platforms.
 */
export function toPosixRelative(
  from: string,
  to: string,
  platform: NodeJS.Platform = hostPlatform(),
): string {
  const impl = pathImplForPlatform(platform);
  return impl.relative(from, to).split(impl.sep).join("/");
}

/**
 * THE home-directory resolver: `os.homedir()`, overridable ONLY via the explicit
 * COWORK_HOME_OVERRIDE env lever (tests/embedders). POSIX honors the supplied env's
 * HOME so embedded servers remain confined to their configured account. Windows
 * deliberately ignores HOME: a Git-Bash-exported value once split auth
 * (`~/.cowork/auth`) from config into two different homes (CLAUDE.md scar tissue).
 */
export function home(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = hostPlatform(),
): string {
  const impl = pathImplForPlatform(platform);
  const override = env.COWORK_HOME_OVERRIDE?.trim();
  if (override) {
    return impl.resolve(override);
  }
  const posixHome = env.HOME?.trim();
  if (platform !== "win32" && posixHome) {
    return impl.resolve(posixHome);
  }
  return os.homedir();
}

/**
 * The single `~/.cowork` root, derived from {@link home} so the COWORK_HOME_OVERRIDE
 * lever and the no-HOME-on-Windows rule apply uniformly on every platform.
 */
export function coworkHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home(env), ".cowork");
}

/**
 * Canonical layout of the `~/.cowork` tree — one assembly point for every platform, so
 * paths like the codex auth dir (`~/.cowork/auth/codex-cli`) are never string-built at
 * call sites again. All values are absolute native paths derived from {@link coworkHome}.
 */
export function coworkPaths(env: NodeJS.ProcessEnv = process.env): {
  root: string;
  authDir: string;
  codexAuthDir: string;
  runtimeDir: string;
  binDir: string;
  skillsDir: string;
  chatsDir: string;
  configDir: string;
} {
  const root = coworkHome(env);
  const authDir = path.join(root, "auth");
  return {
    root,
    authDir,
    codexAuthDir: path.join(authDir, "codex-cli"),
    runtimeDir: path.join(root, "runtime"),
    binDir: path.join(root, "bin"),
    skillsDir: path.join(root, "skills"),
    chatsDir: path.join(root, "chats"),
    configDir: path.join(root, "config"),
  };
}

const INVALID_FILE_NAME_SYMBOLS = /[<>:"/\\|?*]/;

/** NUL and every other C0 control character is invalid in portable file names. */
function containsControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) < 32) {
      return true;
    }
  }
  return false;
}

const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const MAX_FILE_NAME_LENGTH = 255;

function reservedDeviceStem(name: string): string {
  const dotIndex = name.indexOf(".");
  const stem = dotIndex === -1 ? name : name.slice(0, dotIndex);
  return stem.replace(/ +$/, "");
}

/**
 * Validates a single file-name component against ONE portable rule set applied on ALL
 * platforms (so a name accepted on linux never breaks a win32 checkout): rejects both
 * separator families, NUL/control chars, `<>:"|?*` (":" also blocks NTFS alternate data
 * streams), trailing dots/spaces, reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9,
 * with or without extension), `.`/`..`, empty names, and names over 255 chars.
 */
export function validateFileName(name: string): { ok: true } | { ok: false; reason: string } {
  if (name.length === 0) {
    return { ok: false, reason: "empty file name" };
  }
  if (name === "." || name === "..") {
    return { ok: false, reason: "dot segment is not a file name" };
  }
  if (containsControlChar(name) || INVALID_FILE_NAME_SYMBOLS.test(name)) {
    return { ok: false, reason: 'contains a path separator, control char, or one of <>:"|?*' };
  }
  if (/[. ]$/.test(name)) {
    return { ok: false, reason: "trailing dot or space" };
  }
  if (RESERVED_DEVICE_NAMES.test(reservedDeviceStem(name))) {
    return { ok: false, reason: "reserved device name" };
  }
  if (name.length > MAX_FILE_NAME_LENGTH) {
    return { ok: false, reason: `longer than ${MAX_FILE_NAME_LENGTH} characters` };
  }
  return { ok: true };
}

/**
 * Walks up from `startDir` to the nearest directory containing a `.git` entry (directory
 * OR file — worktrees/submodules use a `.git` file). Loop-safe at drive roots, UNC roots,
 * and `/` on every platform (terminates when dirname is a fixed point). Returns null when
 * no repository root exists above `startDir`.
 */
export function findGitRootSync(
  startDir: string,
  opts: {
    /** Test seam: replace the real fs.existsSync probe. */
    exists?: (p: string) => boolean;
  } = {},
): string | null {
  const exists = opts.exists ?? fs.existsSync;
  let current = path.resolve(startDir);
  for (;;) {
    if (exists(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function isWin32ShapedPattern(pattern: string): boolean {
  const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  return /^[A-Za-z]:[\\/]/.test(body) || /^\\\\[^\\/]/.test(body);
}

/**
 * Rewrites backslashes to forward slashes for glob engines, but ONLY when the platform is
 * win32 (where `\` is a separator, never an escape) or the pattern itself is win32-shaped
 * (drive-qualified or UNC). On POSIX platforms, plain patterns keep fast-glob escapes like
 * `\*` intact — the unconditional rewrite in tools/glob.ts destroyed them.
 */
export function normalizeGlobPattern(
  pattern: string,
  platform: NodeJS.Platform = hostPlatform(),
): string {
  if (platform === "win32" || isWin32ShapedPattern(pattern)) {
    return pattern.replaceAll("\\", "/");
  }
  return pattern;
}
