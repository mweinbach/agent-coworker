function runtimePlatform(): NodeJS.Platform {
  return typeof process !== "undefined" ? process.platform : "linux";
}

function runtimeCwd(platform: NodeJS.Platform): string {
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    const cwd = process.cwd();
    if (platform === "win32") {
      const normalized = cwd.replaceAll("/", "\\");
      if (/^(?:[a-zA-Z]:\\|\\\\)/.test(normalized)) return normalized;
    } else if (cwd.startsWith("/")) {
      return cwd;
    }
  }
  return platform === "win32" ? "C:\\" : "/";
}

function normalizeSegments(segments: string[]): string[] {
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

function resolvePosixPath(value: string): string {
  const absolute = value.startsWith("/") ? value : `${runtimeCwd("linux")}/${value}`;
  const segments = normalizeSegments(absolute.split("/"));
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

function resolveWindowsPath(value: string): string {
  const normalized = value.replaceAll("/", "\\");
  const uncMatch = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(normalized);
  if (uncMatch) {
    const root = `\\\\${uncMatch[1]}\\${uncMatch[2]}`;
    const segments = normalizeSegments((uncMatch[3] ?? "").split("\\"));
    return segments.length > 0 ? `${root}\\${segments.join("\\")}` : root;
  }

  const driveMatch = /^([a-zA-Z]:)(?:\\(.*))?$/.exec(normalized);
  if (driveMatch) {
    const root = driveMatch[1] ?? "C:";
    const segments = normalizeSegments((driveMatch[2] ?? "").split("\\"));
    return segments.length > 0 ? `${root}\\${segments.join("\\")}` : `${root}\\`;
  }

  const cwd = runtimeCwd("win32");
  return resolveWindowsPath(`${cwd.replace(/\\$/, "")}\\${normalized}`);
}

/**
 * Lexical workspace path canonicalization for comparisons (no filesystem realpath).
 * Trims, then resolves `.` / `..` / redundant separators so two strings that denote the same path
 * usually compare equal. Windows paths are case-folded because workspace lookups there are
 * case-insensitive in practice.
 */
export function canonicalWorkspacePath(
  dir: string,
  platform: NodeJS.Platform = runtimePlatform(),
): string {
  const trimmed = dir.trim();
  if (!trimmed) return trimmed;
  const resolved = platform === "win32" ? resolveWindowsPath(trimmed) : resolvePosixPath(trimmed);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function sameWorkspacePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = runtimePlatform(),
): boolean {
  return canonicalWorkspacePath(a, platform) === canonicalWorkspacePath(b, platform);
}

/**
 * Returns true when either path is a prefix (ancestor) of or equal to the other.
 * This catches the case where copying sourceRoot into a subtree of itself would recurse.
 */
export function workspacePathOverlaps(
  a: string,
  b: string,
  platform: NodeJS.Platform = runtimePlatform(),
): boolean {
  const ca = canonicalWorkspacePath(a, platform);
  const cb = canonicalWorkspacePath(b, platform);
  if (ca === cb) return true;
  const sep = platform === "win32" ? "\\" : "/";
  return ca.startsWith(cb + sep) || cb.startsWith(ca + sep);
}
