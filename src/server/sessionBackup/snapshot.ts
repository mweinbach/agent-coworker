import fs from "node:fs/promises";
import path from "node:path";

import type { SessionBackupMetadataSnapshot } from "./metadata";
import { copyDirectory, copyDirectoryContents, directoryByteSize } from "./fileSystem";
import { createTarGz, extractTarGz } from "./tar";

export async function createSnapshotWithTarFallback(opts: {
  sourceDir: string;
  sessionDir: string;
  tarPath: string;
  directoryPath: string;
}): Promise<SessionBackupMetadataSnapshot> {
  const archivePath = path.join(opts.sessionDir, opts.tarPath);
  try {
    await createTarGz(opts.sourceDir, archivePath);
    return { kind: "tar_gz", path: opts.tarPath };
  } catch {
    const directoryPath = path.join(opts.sessionDir, opts.directoryPath);
    await copyDirectory(opts.sourceDir, directoryPath);
    return { kind: "directory", path: opts.directoryPath };
  }
}

export async function snapshotByteSize(sessionDir: string, snapshot: SessionBackupMetadataSnapshot): Promise<number> {
  const absolutePath = path.join(sessionDir, snapshot.path);
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
  const absolutePath = path.join(opts.sessionDir, opts.snapshot.path);
  if (opts.snapshot.kind === "tar_gz") {
    await extractTarGz(absolutePath, opts.targetDir);
    return;
  }
  await copyDirectoryContents(absolutePath, opts.targetDir);
}
