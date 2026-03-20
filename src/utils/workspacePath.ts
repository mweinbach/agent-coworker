import path from "node:path";

/**
 * Lexical workspace path canonicalization for comparisons (no filesystem realpath).
 * Trims, then resolves `.` / `..` / redundant separators so two strings that denote the same path
 * usually compare equal.
 */
export function canonicalWorkspacePath(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) return trimmed;
  return path.resolve(trimmed);
}

export function sameWorkspacePath(a: string, b: string): boolean {
  return canonicalWorkspacePath(a) === canonicalWorkspacePath(b);
}
