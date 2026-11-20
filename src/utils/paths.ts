import path from "node:path";

import { crossesProtectedMetadata } from "../platform/paths";

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
