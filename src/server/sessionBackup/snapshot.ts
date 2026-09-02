import { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalizePathForBoundaryCheckSync } from "../../utils/paths";
import {
  copyDirectory,
  copyDirectoryContents,
  directoryByteSize,
  isPathWithin,
} from "./fileSystem";
import type { SessionBackupMetadataSnapshot } from "./metadata";
import { createTarGz, extractTarGz } from "./tar";

/**
 * Resolve a snapshot's stored relative path against its backup session directory,
 * refusing any path that escapes the session directory. Backup metadata is
 * attacker-tamperable in our threat model, so the snapshot path is treated as
 * untrusted and re-validated immediately before any stat/copy/extract/remove —
 * even though {@link readMetadata} already rejects non-contained paths at load.
 */
export function resolveSnapshotPath(sessionDir: string, snapshotPath: string): string {
  const sessionRoot = path.resolve(sessionDir);
  const absolutePath = path.resolve(sessionRoot, snapshotPath);
  const canonicalRoot = canonicalizePathForBoundaryCheckSync(sessionRoot);
  const canonicalPath = canonicalizePathForBoundaryCheckSync(absolutePath);
  if (
    !isPathWithin(sessionRoot, absolutePath) ||
    canonicalPath === canonicalRoot ||
    !isPathWithin(canonicalRoot, canonicalPath)
  ) {
    throw new Error(
      `Refusing to use backup snapshot path outside the session directory: ${snapshotPath}`,
    );
  }
  // Canonicalization can stop at a missing target and miss a dangling symlink.
  // Snapshot storage is generated as real directories/files, so reject links in
  // the reference itself (not links contained inside a saved workspace).
  for (let currentPath = absolutePath; ; currentPath = path.dirname(currentPath)) {
    try {
      if (lstatSync(currentPath).isSymbolicLink()) {
        throw new Error(`Refusing to use a symlink in backup snapshot path: ${snapshotPath}`);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    if (path.relative(sessionRoot, currentPath) === "") break;
  }
  return canonicalPath;
}

export async function createSnapshotWithTarFallback(opts: {
  sourceDir: string;
  sessionDir: string;
  tarPath: string;
  directoryPath: string;
}): Promise<SessionBackupMetadataSnapshot> {
  const directoryPath = resolveSnapshotPath(opts.sessionDir, opts.directoryPath);
  const archivePath = resolveSnapshotPath(opts.sessionDir, opts.tarPath);
  // Windows' bundled tar can be slow and shell-dependent; directory snapshots
  // keep checkpoint/restore reliable without an external process.
  if (process.platform === "win32") {
    await copyDirectory(opts.sourceDir, directoryPath);
    return { kind: "directory", path: opts.directoryPath };
  }

  const tarStageDir = await fs.mkdtemp(path.join(opts.sessionDir, ".snapshot-stage-"));
  try {
    // Stage a filtered copy so scratchpad state never enters tar snapshots.
    await copyDirectoryContents(opts.sourceDir, tarStageDir);
    await createTarGz(tarStageDir, archivePath);
    return { kind: "tar_gz", path: opts.tarPath };
  } catch {
    await fs.rm(archivePath, { force: true }).catch(() => {});
    await copyDirectory(opts.sourceDir, directoryPath);
    return { kind: "directory", path: opts.directoryPath };
  } finally {
    await fs.rm(tarStageDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function snapshotByteSize(
  sessionDir: string,
  snapshot: SessionBackupMetadataSnapshot,
): Promise<number> {
  const absolutePath = resolveSnapshotPath(sessionDir, snapshot.path);
  if (snapshot.kind === "tar_gz") {
    const stat = await fs.stat(absolutePath);
    return stat.size;
  }
  return directoryByteSize(absolutePath);
}

export async function restoreSnapshot(opts: {
  sessionDir: string;
  targetDir: string;
  snapshot: SessionBackupMetadataSnapshot;
}): Promise<void> {
  const absolutePath = resolveSnapshotPath(opts.sessionDir, opts.snapshot.path);
  if (opts.snapshot.kind === "tar_gz") {
    await extractTarGz(absolutePath, opts.targetDir);
    return;
  }
  await copyDirectoryContents(absolutePath, opts.targetDir);
}
