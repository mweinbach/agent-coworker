import fs from "node:fs";
import fsPromises from "node:fs/promises";
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

  while (true) {
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

function stripTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 1 && (p[end - 1] === "/" || p[end - 1] === "\\")) {
    end -= 1;
  }
  const stripped = p.slice(0, end);
  // Never strip a drive root down to "C:" — that spelling is drive-RELATIVE on win32.
  if (/^[A-Za-z]:$/.test(stripped) && end < p.length) {
    return p.slice(0, end + 1);
  }
  return stripped;
}

function foldForPlatform(p: string, platform: NodeJS.Platform): string {
  return fsCaseSensitivity(platform) === "insensitive" ? p.toLowerCase() : p;
}

/**
 * THE Map/Set/lock dedupe key: canonicalized, trailing separators stripped, case-folded on
 * win32 AND darwin. On case-sensitive APFS two genuinely distinct paths may share a key;
 * that is acceptable for this function's consumers (dedupe, lock keying, cache keys) where
 * a collision merges entries conservatively — it never grants filesystem access. Do NOT
 * use it as an accept-side security predicate; use {@link isInside} for that.
 */
export function canonicalKey(p: string, platform: NodeJS.Platform = hostPlatform()): string {
  return foldForPlatform(stripTrailingSeparators(canonicalizeSync(p)), platform);
}

/**
 * Whether two paths refer to the same filesystem location. Both sides are canonicalized
 * via the single native engine; case is folded ONLY on win32 (always case-insensitive).
 * On darwin, canonicalization already restores on-disk casing for existing paths, and
 * lexical folding would wrongly equate distinct paths on case-sensitive APFS.
 */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  const keyA = stripTrailingSeparators(canonicalizeSync(a));
  const keyB = stripTrailingSeparators(canonicalizeSync(b));
  if (platform === "win32") {
    return keyA.toLowerCase() === keyB.toLowerCase();
  }
  return keyA === keyB;
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
 * Asserts `target` canonicalizes to a location inside at least one of `roots` and returns
 * the canonical target. ACCEPT-side like {@link isInside} (same fail-direction rule:
 * case-folds only on win32; exact on darwin so case-sensitive APFS never widens the
 * accepted set). One implementation for the server and desktop validation twins.
 */
export function assertWithinRoots(
  roots: string[],
  target: string,
  opts: {
    platform?: NodeJS.Platform;
    /** Test seam: replace the real-filesystem canonicalizer (defaults to canonicalizeSync). */
    canonicalize?: (p: string) => string;
  } = {},
): string {
  const canonicalizeFn = opts.canonicalize ?? canonicalizeSync;
  const canonicalTarget = canonicalizeFn(target);
  for (const root of roots) {
    const inside = isInside(root, canonicalTarget, {
      platform: opts.platform,
      canonicalize: canonicalizeFn,
    });
    if (inside) {
      return canonicalTarget;
    }
  }
  throw new Error(`Path is outside the permitted roots: ${canonicalTarget}`);
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
  const impl = pathImplForPlatform(platform);
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
 * Whether `p` is absolute under ANY platform's rules (posix `/x`, win32 drive `C:\x`,
 * rooted `\x`, or UNC `\\host\share`). For classifying foreign-recorded paths (e.g.
 * imported conversation transcripts) whose origin platform is unknown. Drive-relative
 * `C:foo` is absolute on no platform and returns false.
 */
export function isAbsoluteAnyPlatform(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/**
 * Whether `p` is fully qualified — unambiguous without any cwd/drive context. On win32
 * this REJECTS drive-relative `C:foo` and rootless `\foo` / `/foo` (both depend on the
 * process's current drive), accepting only `C:\...`, `C:/...`, UNC `\\host\...`, and
 * verbatim `\\?\...` forms. On posix platforms it is plain isAbsolute.
 */
export function isFullyQualified(p: string, platform: NodeJS.Platform = hostPlatform()): boolean {
  if (platform !== "win32") {
    return path.posix.isAbsolute(p);
  }
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
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
 * Joins a POSIX-style relative path (as produced by {@link toPosixRelative}) back onto
 * `root` using the platform's native separators. Purely lexical — callers must validate
 * containment (e.g. via {@link isInside}) separately; `..` segments are not rejected here.
 */
export function fromPosixRelative(
  root: string,
  rel: string,
  platform: NodeJS.Platform = hostPlatform(),
): string {
  const impl = pathImplForPlatform(platform);
  const segments = rel.split("/").filter((segment) => segment.length > 0);
  return impl.join(root, ...segments);
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
  const override = env.COWORK_HOME_OVERRIDE?.trim();
  if (override) {
    return path.resolve(override);
  }
  const posixHome = env.HOME?.trim();
  if (platform !== "win32" && posixHome) {
    return path.resolve(posixHome);
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

/**
 * Expands a leading `~` or `~/`/`~\` to the home directory on every platform. `~user/x`
 * THROWS instead of silently mis-expanding to `$HOME/user/x` (we cannot resolve other
 * users' homes portably). Paths without a leading `~` pass through unchanged.
 */
export function expandHome(p: string, opts: { home?: string } = {}): string {
  if (!p.startsWith("~")) {
    return p;
  }
  const homeDir = opts.home ?? home();
  if (p === "~") {
    return homeDir;
  }
  const next = p[1];
  if (next === "/" || next === "\\") {
    return path.join(homeDir, ...p.slice(2).split(/[\\/]+/));
  }
  throw new Error(`Unsupported home-relative path (only "~" and "~/..." expand): ${p}`);
}

/**
 * Human-UI-ONLY rendering that abbreviates the home directory as `~` (native separators).
 * Model-visible text must always use absolute paths — no built-in tool expands `~`.
 * Paths outside home are returned resolved and unabbreviated on every platform.
 */
export function displayPath(p: string, opts: { home?: string } = {}): string {
  const homeDir = path.resolve(opts.home ?? home());
  const resolved = path.resolve(p);
  const rel = path.relative(homeDir, resolved);
  if (rel === "") {
    return "~";
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return resolved;
  }
  return `~${path.sep}${rel}`;
}

const INVALID_FILE_NAME_SYMBOLS = /[<>:"/\\|?*]/;
const INVALID_FILE_NAME_SYMBOLS_GLOBAL = /[<>:"/\\|?*]/g;

/** NUL and every other C0 control character is invalid in portable file names. */
function containsControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) < 32) {
      return true;
    }
  }
  return false;
}

function replaceControlChars(name: string, replacement: string): string {
  let out = "";
  for (const ch of name) {
    out += (ch.codePointAt(0) ?? 32) < 32 ? replacement : ch;
  }
  return out;
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
 * Rewrites a file-name component until it passes {@link validateFileName}, using the same
 * portable rule set on ALL platforms: invalid chars → `replacement` (default "_"),
 * trailing dots/spaces trimmed, reserved device names prefixed, length capped at 255,
 * empty results become "_". `replacement` must itself be a portable name fragment.
 */
export function sanitizeFileName(name: string, opts: { replacement?: string } = {}): string {
  const replacement = opts.replacement ?? "_";
  let out = replaceControlChars(name, replacement).replace(
    INVALID_FILE_NAME_SYMBOLS_GLOBAL,
    replacement,
  );
  out = out.replace(/[. ]+$/, "");
  if (RESERVED_DEVICE_NAMES.test(reservedDeviceStem(out))) {
    out = `${replacement.length > 0 ? replacement : "_"}${out}`;
  }
  if (out.length > MAX_FILE_NAME_LENGTH) {
    out = out.slice(0, MAX_FILE_NAME_LENGTH).replace(/[. ]+$/, "");
  }
  if (out.length === 0) {
    return "_";
  }
  return out;
}

/**
 * Filename-safe ISO-8601 UTC timestamp — identical output on every platform, with no ":"
 * (NTFS alternate data streams) and no "." (extension confusion): e.g.
 * `2026-07-07T01-02-03-004Z`. Passes {@link validateFileName} by construction.
 */
export function timestampSegment(date: Date = new Date()): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
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
  while (true) {
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

/**
 * Async twin of {@link findGitRootSync} with the identical walk and the identical
 * drive/UNC-root termination guarantee on every platform.
 */
export async function findGitRoot(
  startDir: string,
  opts: {
    /** Test seam: replace the real fs access probe. */
    exists?: (p: string) => boolean | Promise<boolean>;
  } = {},
): Promise<string | null> {
  const exists =
    opts.exists ??
    (async (p: string) => {
      try {
        await fsPromises.access(p);
        return true;
      } catch {
        return false;
      }
    });
  let current = path.resolve(startDir);
  while (true) {
    if (await exists(path.join(current, ".git"))) {
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

/**
 * Splits an absolute glob pattern into a concrete search root and a relative rest pattern,
 * with drive-qualified roots on win32 (`C:/` — never drive-relative `C:`) and UNC roots
 * preserved. Returns null for relative (or negated) patterns; separators in the result are
 * always forward slashes via {@link normalizeGlobPattern}.
 */
export function splitAbsoluteGlob(
  pattern: string,
  platform: NodeJS.Platform = hostPlatform(),
): { root: string; rest: string } | null {
  const normalized = normalizeGlobPattern(pattern, platform);
  const driveQualified = /^[A-Za-z]:\//.test(normalized);
  const unc = /^\/\/[^/]/.test(normalized);
  const posixRooted = normalized.startsWith("/") && !unc;
  if (!driveQualified && !unc && !posixRooted) {
    return null;
  }
  const firstMagic = normalized.search(/[*?[{]/);
  const staticPrefix = firstMagic === -1 ? normalized : normalized.slice(0, firstMagic);
  const lastSlash = staticPrefix.lastIndexOf("/");
  if (lastSlash === -1) {
    return null;
  }
  let root = normalized.slice(0, lastSlash);
  const rest = normalized.slice(lastSlash + 1);
  if (root === "") {
    root = "/";
  }
  if (/^[A-Za-z]:$/.test(root)) {
    root = `${root}/`;
  }
  return { root, rest };
}
