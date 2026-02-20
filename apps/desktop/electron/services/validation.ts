import fs from "node:fs";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;

function normalizeBoundaryPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // If file doesn't exist, try to get realpath of the parent directory
    try {
      const parent = path.dirname(resolved);
      const parentRealpath = fs.realpathSync(parent);
      return path.join(parentRealpath, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

export function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(`${label} contains invalid characters`);
  }
}

export function assertValidFileName(name: string, label: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0") || name === ".." || name === ".") {
    throw new Error(`${label} is invalid`);
  }
}

export function assertWorkspaceDirectory(workspacePath: string): void {
  if (!workspacePath.trim()) {
    throw new Error("workspacePath must not be empty");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspacePath);
  } catch {
    throw new Error(`Workspace path does not exist: ${workspacePath}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${workspacePath}`);
  }
}

export function assertDirection(direction: string): "server" | "client" {
  const normalized = direction.trim().toLowerCase();
  if (normalized !== "server" && normalized !== "client") {
    throw new Error("direction must be 'server' or 'client'");
  }
  return normalized;
}

export function assertWithinTranscriptsDir(root: string, filePath: string): void {
  const normalizedRoot = path.resolve(root);
  const normalizedPath = path.resolve(filePath);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Resolved transcript path escapes transcript root");
  }
}

export function assertPathWithinRoots(roots: string[], targetPath: string, label: string): string {
  if (!targetPath.trim()) {
    throw new Error(`${label} must not be empty`);
  }

  const normalizedTarget = normalizeBoundaryPath(targetPath);
  for (const root of roots) {
    const normalizedRoot = normalizeBoundaryPath(root);
    if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
      return normalizedTarget;
    }
  }

  throw new Error(`${label} is outside allowed workspace roots`);
}
