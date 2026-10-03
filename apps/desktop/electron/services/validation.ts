import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { hostPlatform } from "../../../../src/platform/host";
import { canonicalizeSync } from "../../../../src/platform/paths";
import { isPathEqualOrInside } from "./pathBoundary";

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(`${label} contains invalid characters`);
  }
}

export function assertValidFileName(name: string, label: string): void {
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === ".." ||
    name === "."
  ) {
    throw new Error(`${label} is invalid`);
  }
}

export async function assertWorkspaceDirectory(workspacePath: string): Promise<void> {
  if (!workspacePath.trim()) {
    throw new Error("workspacePath must not be empty");
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(workspacePath);
  } catch {
    throw new Error(
      `Workspace folder is unavailable: ${workspacePath}. Reconnect its drive or restore access, then retry.`,
    );
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
  if (!isPathEqualOrInside(normalizedRoot, normalizedPath)) {
    throw new Error("Resolved transcript path escapes transcript root");
  }
}

const WINDOWS_DRIVE_LONG_PATH_RE = /^[\\/]{2}\?[\\/][A-Za-z]:(?:[\\/]|$)/;
const WINDOWS_UNC_SHARE_RE = /^[\\/]{2}(?:\?[\\/]UNC[\\/])?([^\\/]+)[\\/]+([^\\/]+)/i;

type WindowsRemotePath = { kind: "local" } | { kind: "device" } | { kind: "share"; share: string };

function classifyWindowsRemotePath(targetPath: string): WindowsRemotePath {
  if (WINDOWS_DRIVE_LONG_PATH_RE.test(targetPath)) {
    return { kind: "local" };
  }
  const share = WINDOWS_UNC_SHARE_RE.exec(targetPath);
  if (share && share[1] !== "?" && share[1] !== ".") {
    return { kind: "share", share: `${share[1]}\\${share[2]}`.toLowerCase() };
  }
  return /^[\\/]{2}/.test(targetPath) ? { kind: "device" } : { kind: "local" };
}

/**
 * Rejects Windows UNC (`\\server\share`, `\\?\UNC\server\share`) and device-namespace
 * (`\\.\`, `\\?\GLOBALROOT`) targets lexically, before anything touches the filesystem:
 * realpath/stat on a UNC path opens an SMB session, which hands the user's NTLM hash to
 * whatever host a rendered link or image names. A share is allowed only when an approved
 * root lives on that same share.
 */
export function assertNoUnapprovedRemotePath(
  roots: readonly string[],
  targetPath: string,
  label: string,
  platform: NodeJS.Platform = hostPlatform(),
): void {
  if (platform !== "win32") {
    return;
  }
  const target = classifyWindowsRemotePath(targetPath.trim());
  if (target.kind === "local") {
    return;
  }
  if (target.kind === "share") {
    for (const root of roots) {
      const rootTarget = classifyWindowsRemotePath(root.trim());
      if (rootTarget.kind === "share" && rootTarget.share === target.share) {
        return;
      }
    }
  }
  throw new Error(`${label} is outside allowed workspace roots`);
}

export function assertPathWithinRoots(roots: string[], targetPath: string, label: string): string {
  if (!targetPath.trim()) {
    throw new Error(`${label} must not be empty`);
  }
  assertNoUnapprovedRemotePath(roots, targetPath, label);

  const normalizedTarget = canonicalizeSync(targetPath);
  for (const root of roots) {
    const normalizedRoot = canonicalizeSync(root);
    if (isPathEqualOrInside(normalizedRoot, normalizedTarget)) {
      return normalizedTarget;
    }
  }

  throw new Error(`${label} is outside allowed workspace roots`);
}

/** Authorize a directory entry without following the leaf being renamed or trashed. */
export function assertDirectoryEntryWithinRoots(
  roots: string[],
  targetPath: string,
  label: string,
): string {
  if (!targetPath.trim()) {
    throw new Error(`${label} must not be empty`);
  }
  assertNoUnapprovedRemotePath(roots, targetPath, label);
  const resolved = path.resolve(targetPath);
  const parent = fs.realpathSync.native(path.dirname(resolved));
  const entryPath = path.join(parent, path.basename(resolved));
  for (const root of roots) {
    if (isPathEqualOrInside(canonicalizeSync(root), entryPath)) {
      return entryPath;
    }
  }
  throw new Error(`${label} is outside allowed workspace roots`);
}
