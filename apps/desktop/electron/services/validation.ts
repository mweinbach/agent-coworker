import fs from "node:fs";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(`${label} contains invalid characters`);
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
