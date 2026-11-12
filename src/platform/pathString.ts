/**
 * Pure string path operations shared by the server, the Electron renderer, and mobile.
 *
 * Browser-safe by construction: zero node:* imports, no filesystem access, and no
 * process.platform reads. Every function takes an explicit {@link PathStyle} — there is
 * deliberately no host-platform default, because a silent "linux" fallback in shared UI
 * code was the documented trap this module replaces (src/utils/workspacePath.ts).
 *
 * win32 semantics follow node:path.win32 (verified by a differential test suite), with
 * three intentional, documented divergences:
 * - `resolve` de-namespaces `\\?\C:\...` / `\\?\UNC\server\share\...` verbatim prefixes
 *   to their plain drive/UNC forms (node keeps the prefix and mis-parses `?` as a UNC
 *   server — the workspacePath.ts:52 bug this module fixes).
 * - `dirname` never yields a drive-relative `"C:"`; it returns the drive root `"C:\"`.
 * - `resolve` of a drive-relative path whose drive differs from `cwd` starts at that
 *   drive's root (deterministic) instead of consulting hidden per-drive process state.
 */

export type PathStyle = "win32" | "posix";

const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_DOT = 46;
const CHAR_COLON = 58;

function isWin32Separator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

function isPosixSeparator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH;
}

function isDriveLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Maps a runtime platform id to the path syntax it uses: "win32" for win32, "posix" for
 * every other platform (darwin, linux, and the rest). The only sanctioned bridge from
 * platform identity to PathStyle; callers thread the SERVER-reported platform, never a
 * renderer-local guess.
 */
export function styleFor(platform: NodeJS.Platform): PathStyle {
  return platform === "win32" ? "win32" : "posix";
}

// ---------------------------------------------------------------------------
// Verbatim (\\?\ and \\.\) prefix handling
// ---------------------------------------------------------------------------

type VerbatimParse =
  | { kind: "drive"; path: string }
  | { kind: "unc"; path: string }
  | { kind: "device"; root: string; rest: string };

/** Parses a `\\?\` or `\\.\` prefixed win32 path (either separator family). */
function parseVerbatimPrefix(p: string): VerbatimParse | null {
  const m = /^[\\/]{2}([?.])[\\/]+([\s\S]*)$/.exec(p);
  if (!m) return null;
  const marker = m[1] ?? "?";
  const payload = m[2] ?? "";
  const unc = /^UNC[\\/]+([\s\S]*)$/i.exec(payload);
  if (unc) return { kind: "unc", path: `\\\\${unc[1] ?? ""}` };
  if (/^[A-Za-z]:$/.test(payload)) return { kind: "drive", path: `${payload}\\` };
  if (/^[A-Za-z]:[\\/]/.test(payload)) return { kind: "drive", path: payload };
  const firstSep = payload.search(/[\\/]/);
  if (firstSep === -1) return { kind: "device", root: `\\\\${marker}\\${payload}`, rest: "" };
  return {
    kind: "device",
    root: `\\\\${marker}\\${payload.slice(0, firstSep)}`,
    rest: payload.slice(firstSep),
  };
}

/** Rewrites `\\?\C:\x` → `C:\x` and `\\?\UNC\s\v\x` → `\\s\v\x`; other input unchanged. */
function denamespaceVerbatim(p: string): string {
  const v = parseVerbatimPrefix(p);
  if (v === null || v.kind === "device") return p;
  return v.path;
}

// ---------------------------------------------------------------------------
// Core normalization engine (port of node:path's normalizeString)
// ---------------------------------------------------------------------------

function normalizeString(
  path: string,
  allowAboveRoot: boolean,
  separator: string,
  isSeparator: (code: number) => boolean,
): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) {
      code = path.charCodeAt(i);
    } else if (isSeparator(code)) {
      break;
    } else {
      code = CHAR_FORWARD_SLASH;
    }

    if (isSeparator(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP: empty segment or "."
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== CHAR_DOT ||
          res.charCodeAt(res.length - 2) !== CHAR_DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf(separator);
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          }
          if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? `${separator}..` : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) {
          res += `${separator}${path.slice(lastSlash + 1, i)}`;
        } else {
          res = path.slice(lastSlash + 1, i);
        }
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Root parsing / normalize (private; node:path.win32-equivalent)
// ---------------------------------------------------------------------------

type Win32Root = { device: string; rootEnd: number; isAbsolute: boolean };

function parseWin32Root(path: string): Win32Root {
  const len = path.length;
  let rootEnd = 0;
  let device = "";
  let absolute = false;
  const code = path.charCodeAt(0);
  if (isWin32Separator(code)) {
    rootEnd = 1;
    absolute = true;
    if (isWin32Separator(path.charCodeAt(1))) {
      let j = 2;
      let last = j;
      while (j < len && !isWin32Separator(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        const firstPart = path.slice(last, j);
        last = j;
        while (j < len && isWin32Separator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isWin32Separator(path.charCodeAt(j))) j++;
          if (j === len || j !== last) {
            device = `\\\\${firstPart}\\${path.slice(last, j)}`;
            rootEnd = j;
          }
        }
      }
    }
  } else if (len > 1 && isDriveLetter(code) && path.charCodeAt(1) === CHAR_COLON) {
    device = path.slice(0, 2);
    rootEnd = 2;
    if (len > 2 && isWin32Separator(path.charCodeAt(2))) {
      absolute = true;
      rootEnd = 3;
    }
  }
  return { device, rootEnd, isAbsolute: absolute };
}

function normalizeWin32(path: string): string {
  const len = path.length;
  if (len === 0) return ".";
  let rootEnd = 0;
  let device: string | undefined;
  let absolute = false;
  const code = path.charCodeAt(0);
  if (isWin32Separator(code)) {
    absolute = true;
    rootEnd = 1;
    if (isWin32Separator(path.charCodeAt(1))) {
      let j = 2;
      let last = j;
      while (j < len && !isWin32Separator(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        const firstPart = path.slice(last, j);
        last = j;
        while (j < len && isWin32Separator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isWin32Separator(path.charCodeAt(j))) j++;
          if (j === len) {
            // UNC root only; nothing left to process.
            return `\\\\${firstPart}\\${path.slice(last)}\\`;
          }
          if (j !== last) {
            device = `\\\\${firstPart}\\${path.slice(last, j)}`;
            rootEnd = j;
          }
        }
      }
    }
  } else if (len > 1 && isDriveLetter(code) && path.charCodeAt(1) === CHAR_COLON) {
    device = path.slice(0, 2);
    rootEnd = 2;
    if (len > 2 && isWin32Separator(path.charCodeAt(2))) {
      absolute = true;
      rootEnd = 3;
    }
  }
  let tail =
    rootEnd < len ? normalizeString(path.slice(rootEnd), !absolute, "\\", isWin32Separator) : "";
  if (tail.length === 0 && !absolute) tail = ".";
  if (tail.length > 0 && isWin32Separator(path.charCodeAt(len - 1))) tail += "\\";
  if (device === undefined) {
    return absolute ? `\\${tail}` : tail;
  }
  return absolute ? `${device}\\${tail}` : `${device}${tail}`;
}

function normalizePosix(path: string): string {
  if (path.length === 0) return ".";
  const absolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH;
  let normalized = normalizeString(path, !absolute, "/", isPosixSeparator);
  if (normalized.length === 0) {
    if (absolute) return "/";
    return trailingSeparator ? "./" : ".";
  }
  if (trailingSeparator) normalized += "/";
  return absolute ? `/${normalized}` : normalized;
}

// ---------------------------------------------------------------------------
// Default cwd (renderer-safe: never assumes node globals exist)
// ---------------------------------------------------------------------------

function runtimeCwd(): string | null {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  if (proc && typeof proc.cwd === "function") {
    try {
      return proc.cwd();
    } catch {
      return null;
    }
  }
  return null;
}

function defaultCwd(style: PathStyle): string {
  const cwd = runtimeCwd();
  if (cwd) {
    if (style === "win32") {
      const normalized = cwd.replaceAll("/", "\\");
      if (/^(?:[A-Za-z]:\\|\\\\)/.test(normalized)) return normalized;
    } else if (cwd.startsWith("/")) {
      return cwd;
    }
  }
  return style === "win32" ? "C:\\" : "/";
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

function resolveWin32(p: string, cwdOpt?: string): string {
  const verbatim = parseVerbatimPrefix(p);
  if (verbatim?.kind === "device") {
    // \\?\Volume{...}\x or \\.\pipe\x: preserve the device root, lexically normalize the
    // tail, and never let ".." climb above the device root.
    if (verbatim.rest.length === 0) return verbatim.root;
    const rest = normalizeString(verbatim.rest, false, "\\", isWin32Separator);
    return rest.length > 0 ? `${verbatim.root}\\${rest}` : `${verbatim.root}\\`;
  }
  const first = verbatim ? verbatim.path : p;
  const base = denamespaceVerbatim(cwdOpt === undefined ? defaultCwd("win32") : cwdOpt);

  let resolvedDevice = "";
  let resolvedTail = "";
  let resolvedAbsolute = false;
  const candidates = [first, base];

  for (let i = 0; i <= candidates.length; i++) {
    let path: string;
    if (i < candidates.length) {
      path = candidates[i] ?? "";
    } else if (resolvedDevice.length === 0) {
      // Both inputs were relative (misuse); fall back to a deterministic drive root
      // instead of hidden host state.
      path = "C:\\";
    } else {
      // Drive-relative path whose drive differs from cwd: deterministic drive root.
      path = `${resolvedDevice}\\`;
    }
    if (path.length === 0) continue;
    const { device, rootEnd, isAbsolute: absolute } = parseWin32Root(path);
    if (device.length > 0) {
      if (resolvedDevice.length > 0) {
        if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
      } else {
        resolvedDevice = device;
      }
    }
    if (resolvedAbsolute) {
      if (resolvedDevice.length > 0) break;
    } else {
      resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
      resolvedAbsolute = absolute;
      if (absolute && resolvedDevice.length > 0) break;
    }
  }

  const tail = normalizeString(resolvedTail, !resolvedAbsolute, "\\", isWin32Separator);
  if (resolvedAbsolute) return `${resolvedDevice}\\${tail}`;
  const relative = `${resolvedDevice}${tail}`;
  return relative.length > 0 ? relative : ".";
}

function resolvePosix(p: string, cwdOpt?: string): string {
  const base = cwdOpt === undefined ? defaultCwd("posix") : cwdOpt;
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (const path of [p, base, "/"]) {
    if (resolvedAbsolute) break;
    if (path.length === 0) continue;
    resolvedPath = `${path}/${resolvedPath}`;
    resolvedAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }
  const normalized = normalizeString(resolvedPath, !resolvedAbsolute, "/", isPosixSeparator);
  if (resolvedAbsolute) return `/${normalized}`;
  return normalized.length > 0 ? normalized : ".";
}

/**
 * Lexically resolves `p` against `cwd` to an absolute path (no filesystem access).
 * posix: node:path.posix.resolve semantics. win32: node:path.win32.resolve semantics
 * including drive-relative ("C:foo"), rooted ("\foo"), and UNC inputs — plus `\\?\` /
 * `\\.\` verbatim prefixes, which node mis-parses as UNC server "?": `\\?\C:\...` and
 * `\\?\UNC\s\v\...` are de-namespaced to `C:\...` / `\\s\v\...`; other device roots are
 * preserved and ".." never climbs above them. When `cwd` is omitted, the runtime cwd is
 * used if it matches the style's shape, else the style root ("C:\" or "/").
 */
export function resolve(p: string, style: PathStyle, cwd?: string): string {
  return style === "win32" ? resolveWin32(p, cwd) : resolvePosix(p, cwd);
}

// ---------------------------------------------------------------------------
// join / dirname / basename / isAbsolute
// ---------------------------------------------------------------------------

/**
 * Joins and lexically normalizes path segments; identical to node:path.win32.join /
 * node:path.posix.join for the given style on every host (empty parts skipped, "." for
 * no parts, win32 guards against accidentally fabricating a UNC prefix from separators).
 */
export function join(style: PathStyle, ...parts: string[]): string {
  if (style === "posix") {
    let joined: string | undefined;
    for (const part of parts) {
      if (part.length > 0) {
        joined = joined === undefined ? part : `${joined}/${part}`;
      }
    }
    if (joined === undefined) return ".";
    return normalizePosix(joined);
  }

  let joined: string | undefined;
  let firstPart: string | undefined;
  for (const part of parts) {
    if (part.length > 0) {
      if (joined === undefined) {
        joined = part;
        firstPart = part;
      } else {
        joined += `\\${part}`;
      }
    }
  }
  if (joined === undefined || firstPart === undefined) return ".";

  // Make sure joining separators does not fabricate a UNC prefix (node parity).
  let needsReplace = true;
  let slashCount = 0;
  if (isWin32Separator(firstPart.charCodeAt(0))) {
    ++slashCount;
    const firstLen = firstPart.length;
    if (firstLen > 1 && isWin32Separator(firstPart.charCodeAt(1))) {
      ++slashCount;
      if (firstLen > 2) {
        if (isWin32Separator(firstPart.charCodeAt(2))) {
          ++slashCount;
        } else {
          // The first part is an intentional UNC path.
          needsReplace = false;
        }
      }
    }
  }
  if (needsReplace) {
    while (slashCount < joined.length && isWin32Separator(joined.charCodeAt(slashCount))) {
      slashCount++;
    }
    if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
  }
  return normalizeWin32(joined);
}

function dirnamePosix(p: string): string {
  if (p.length === 0) return ".";
  const hasRoot = p.charCodeAt(0) === CHAR_FORWARD_SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = p.length - 1; i >= 1; --i) {
    if (p.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return p.slice(0, end);
}

function dirnameWin32(p: string): string {
  const len = p.length;
  if (len === 0) return ".";
  let rootEnd = -1;
  let offset = 0;
  const code = p.charCodeAt(0);
  if (len === 1) {
    return isWin32Separator(code) ? p : ".";
  }
  if (isWin32Separator(code)) {
    rootEnd = 1;
    offset = 1;
    if (isWin32Separator(p.charCodeAt(1))) {
      let j = 2;
      let last = j;
      while (j < len && !isWin32Separator(p.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        last = j;
        while (j < len && isWin32Separator(p.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isWin32Separator(p.charCodeAt(j))) j++;
          if (j === len) {
            // UNC (or \\?\ device) root only: already its own dirname.
            return p;
          }
          if (j !== last) {
            rootEnd = j + 1;
            offset = rootEnd;
          }
        }
      }
    }
  } else if (isDriveLetter(code) && p.charCodeAt(1) === CHAR_COLON) {
    rootEnd = len > 2 && isWin32Separator(p.charCodeAt(2)) ? 3 : 2;
    offset = rootEnd;
  }
  let end = -1;
  let matchedSlash = true;
  for (let i = len - 1; i >= offset; --i) {
    if (isWin32Separator(p.charCodeAt(i))) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) {
    if (rootEnd === -1) return ".";
    end = rootEnd;
  }
  return p.slice(0, end);
}

/**
 * Parent directory of `p`; node:path semantics for the given style with one intentional
 * divergence: win32 never yields a drive-relative "C:" (whose meaning depends on hidden
 * per-drive cwd state) — where node returns "C:", this returns the drive root "C:\".
 * Roots (drive, UNC, `\\?\` device) are their own dirname; ".." never escapes them.
 */
export function dirname(p: string, style: PathStyle): string {
  if (style === "posix") return dirnamePosix(p);
  const result = dirnameWin32(p);
  return /^[A-Za-z]:$/.test(result) ? `${result}\\` : result;
}

/**
 * Final path segment, treating BOTH separator families as separators on every platform
 * (matches node:path.win32.basename). Divergence from node:path.posix by design: a posix
 * filename containing a literal backslash is split anyway — this function is for
 * display/classification of paths whose origin platform may be unknown.
 */
export function basename(p: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (p.length >= 2 && isDriveLetter(p.charCodeAt(0)) && p.charCodeAt(1) === CHAR_COLON) {
    start = 2;
  }
  for (let i = p.length - 1; i >= start; --i) {
    if (isWin32Separator(p.charCodeAt(i))) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  return p.slice(start, end);
}

/**
 * True when `p` is absolute under the given style (node:path semantics on every host).
 * win32: rooted ("\foo"), drive-rooted ("C:\foo"), UNC, and `\\?\` verbatim paths are
 * absolute; drive-relative "C:foo" is NOT. posix: leading "/" only — a backslash is an
 * ordinary character there.
 */
export function isAbsolute(p: string, style: PathStyle): boolean {
  const len = p.length;
  if (len === 0) return false;
  const code = p.charCodeAt(0);
  if (style === "posix") return code === CHAR_FORWARD_SLASH;
  return (
    isWin32Separator(code) ||
    (len > 2 &&
      isDriveLetter(code) &&
      p.charCodeAt(1) === CHAR_COLON &&
      isWin32Separator(p.charCodeAt(2)))
  );
}

/**
 * Infers the syntax of a fully-qualified local path from the path itself, independent of
 * the current host. Drive-qualified and UNC/device paths are win32; slash-rooted paths
 * are posix. A single leading backslash is deliberately rejected because it is only
 * drive-rooted (not fully qualified), and relative paths have no intrinsic style.
 */
export function absolutePathStyle(p: string): PathStyle | null {
  if (/^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p)) {
    return "win32";
  }
  return p.startsWith("/") ? "posix" : null;
}

// ---------------------------------------------------------------------------
// Comparison keys
// ---------------------------------------------------------------------------

function stripTrailingSeparatorWin32(p: string): string {
  if (!p.endsWith("\\")) return p;
  const body = p.slice(0, -1);
  if (body.length === 0) return p; // "\" (rooted)
  if (/^[A-Za-z]:$/.test(body)) return p; // keep "C:\" — "C:" would be drive-relative
  return body;
}

/**
 * The lexical Map/Set-key form of a path: dot-segments squashed, separators collapsed to
 * the style's canonical family, trailing separator stripped (roots keep theirs), and —
 * win32 only — case-folded and `\\?\` drive/UNC verbatim prefixes de-namespaced, so
 * "C:/Foo/", "c:\\foo" and "\\\\?\\C:\\Foo" all produce one key. posix keys are
 * case-exact. Purely lexical: never touches the filesystem (use paths.canonicalKey for
 * symlink/realpath identity).
 */
export function canonicalKeyLexical(p: string, style: PathStyle): string {
  if (p.length === 0) return "";
  if (style === "posix") {
    const normalized = normalizePosix(p);
    if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
    return normalized;
  }
  const normalized = normalizeWin32(denamespaceVerbatim(p));
  return stripTrailingSeparatorWin32(normalized).toLowerCase();
}

/**
 * Pure lexical containment for already-absolute paths whose syntax may differ from the
 * host. This is useful at serialization and IPC boundaries, where node:path would
 * otherwise reinterpret a posix path as win32 (or vice versa). Filesystem-facing callers
 * must still realpath/canonicalize native paths before granting access so symlinks cannot
 * escape the boundary.
 */
export function isPathEqualOrInsideLexical(
  root: string,
  target: string,
  style: PathStyle,
): boolean {
  if (!isAbsolute(root, style) || !isAbsolute(target, style)) {
    return false;
  }
  const rootKey = canonicalKeyLexical(root, style);
  const targetKey = canonicalKeyLexical(target, style);
  if (rootKey === targetKey) {
    return true;
  }
  const separator = style === "win32" ? "\\" : "/";
  const boundaryPrefix = rootKey.endsWith(separator) ? rootKey : `${rootKey}${separator}`;
  return targetKey.startsWith(boundaryPrefix);
}

// ---------------------------------------------------------------------------
// Separator conversion
// ---------------------------------------------------------------------------

function isWin32Shaped(p: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\")) return true;
  return p.includes("\\") && !p.includes("/");
}

/**
 * Converts backslashes to forward slashes ONLY when the input is win32-shaped (drive
 * prefix, leading backslash, or backslash-separated with no forward slashes). posix
 * paths — including ones with literal backslashes mixed with "/" — pass through
 * unchanged, so this is safe to call on paths of unknown origin on every platform.
 */
export function toPosix(p: string): string {
  return isWin32Shaped(p) ? p.replaceAll("\\", "/") : p;
}

// ---------------------------------------------------------------------------
// file: URLs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local-path regex family (redaction + auto-linking share one source)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Zip entry paths
// ---------------------------------------------------------------------------
