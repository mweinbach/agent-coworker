import fs from "node:fs";
import path from "node:path";

export function resolveMaybeRelative(p: string, baseDir: string): string {
  if (!p) return p;
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.normalize(path.join(baseDir, p));
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));

  // On Windows, crossing drive letters (or UNC roots) returns an absolute
  // relative result (e.g. "D:\\target"), which must be treated as outside.
  if (path.isAbsolute(rel)) return false;

  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== "..");
}

function canonicalizePathFromExistingAncestorSync(targetPath: string): string {
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

export function canonicalizePathForBoundaryCheckSync(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return canonicalizePathFromExistingAncestorSync(targetPath);
    }
    throw error;
  }
}

export function truncateText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

export function truncateLine(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "...";
}
