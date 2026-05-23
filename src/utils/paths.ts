import fs from "node:fs";
import fsPromises from "node:fs/promises";
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

  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== "..");
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

async function canonicalizePathFromExistingAncestor(targetPath: string): Promise<string> {
  const pendingSegments: string[] = [];
  let currentPath = path.resolve(targetPath);

  while (true) {
    try {
      const canonicalExistingPath = await fsPromises.realpath(currentPath);
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

export async function canonicalizePathForBoundaryCheck(targetPath: string): Promise<string> {
  try {
    return await fsPromises.realpath(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return canonicalizePathFromExistingAncestor(targetPath);
    }
    throw error;
  }
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
