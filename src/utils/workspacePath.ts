import path from "node:path";

/**
 * Lexical workspace path canonicalization for comparisons (no filesystem realpath).
 * Trims, then resolves `.` / `..` / redundant separators so two strings that denote the same path
 * usually compare equal. Windows paths are case-folded because workspace lookups there are
 * case-insensitive in practice.
 */
export function canonicalWorkspacePath(dir: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = dir.trim();
  if (!trimmed) return trimmed;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const resolved = pathImpl.resolve(trimmed);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function sameWorkspacePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return canonicalWorkspacePath(a, platform) === canonicalWorkspacePath(b, platform);
}

/**
 * Returns true when either path is a prefix (ancestor) of or equal to the other.
 * This catches the case where copying sourceRoot into a subtree of itself would recurse.
 */
export function workspacePathOverlaps(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const ca = canonicalWorkspacePath(a, platform);
  const cb = canonicalWorkspacePath(b, platform);
  if (ca === cb) return true;
  const sep = platform === "win32" ? "\\" : "/";
  return ca.startsWith(cb + sep) || cb.startsWith(ca + sep);
}
