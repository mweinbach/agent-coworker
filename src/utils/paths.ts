import path from "node:path";

import {
  canonicalize as canonicalizeBoundary,
  canonicalizeSync as canonicalizeBoundarySync,
  crossesProtectedMetadata,
} from "../platform/paths";

export function resolveMaybeRelative(p: string, baseDir: string): string {
  if (!p) return p;
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.normalize(path.join(baseDir, p));
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));

  return rel === "" || !isRelativePathOutsideRoot(rel);
}

function isRelativePathOutsideRoot(relativePath: string): boolean {
  // On Windows, crossing drive letters (or UNC roots) returns an absolute
  // relative result (e.g. "D:\\target"), which must be treated as outside.
  return (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    path.isAbsolute(relativePath)
  );
}

export { PROTECTED_METADATA_DIR_NAMES } from "../platform/paths";

/**
 * Whether `target`, expressed relative to `base`, passes through a protected
 * metadata directory (`.git`/`.cowork`). The check is relative to `base` (the
 * outermost writable boundary, i.e. the project root) so a workspace that merely
 * lives UNDER a `.cowork` ancestor (e.g. a one-off chat under
 * `~/.cowork/chats/<id>`) is not wrongly flagged. Resolve symlinks before
 * calling so an aliased directory cannot smuggle metadata back in.
 *
 * Delegates to platform/paths.crossesProtectedMetadata: segments case-fold on
 * win32 AND darwin (deny-side; over-blocking is safe), closing the `.GIT/hooks`
 * bypass on case-insensitive filesystems.
 */
export function pathCrossesProtectedMetadata(base: string, target: string): boolean {
  return crossesProtectedMetadata(base, target);
}

/**
 * Boundary-check canonicalization delegates to THE single engine
 * (platform/paths canonicalize{,Sync}: native realpath + longest-existing-prefix
 * walk). The async variant previously used JS realpath — a different engine
 * whose output did not always string-match the sync-native form, so
 * canonical-form comparisons could disagree between sync and async callers.
 * Native realpath also resolves on-disk casing for existing prefixes, which the
 * credential-deny and metadata checks rely on for case-insensitive filesystems.
 */
export function canonicalizePathForBoundaryCheckSync(targetPath: string): string {
  return canonicalizeBoundarySync(targetPath);
}

async function canonicalizePathForBoundaryCheck(targetPath: string): Promise<string> {
  return await canonicalizeBoundary(targetPath);
}

export async function resolvePathInsideRootForBoundaryCheck(
  rootPath: string,
  targetPath: string,
): Promise<string> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    throw new Error(`Path is outside root: ${resolvedTarget}`);
  }

  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalizePathForBoundaryCheck(resolvedRoot),
    canonicalizePathForBoundaryCheck(resolvedTarget),
  ]);
  if (!isPathInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`Path resolves outside root: ${canonicalTarget}`);
  }

  return canonicalTarget;
}

export function truncateText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

export function truncateLine(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}...`;
}
