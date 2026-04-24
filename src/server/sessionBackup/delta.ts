import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { WorkspaceBackupDeltaFile } from "../sessionBackup";
import type { SessionBackupMetadataSnapshot } from "./metadata";
import { restoreSnapshot } from "./snapshot";

const DEFAULT_MAX_FILES = 200;

type SnapshotTreeEntry = {
  kind: WorkspaceBackupDeltaFile["kind"];
  digest: string;
};

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function collectSnapshotEntries(
  rootDir: string,
  currentDir: string,
  output: Map<string, SnapshotTreeEntry>,
  maxEntries?: number,
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (maxEntries !== undefined && output.size >= maxEntries) return;

    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      await collectSnapshotEntries(rootDir, absolutePath, output, maxEntries);
      continue;
    }

    if (entry.isFile()) {
      output.set(relativePath, {
        kind: "file",
        digest: await hashFile(absolutePath),
      });
      continue;
    }

    if (entry.isSymbolicLink()) {
      output.set(relativePath, {
        kind: "symlink",
        digest: await fs.readlink(absolutePath).catch(() => "<unreadable>"),
      });
    }
  }
}

async function materializeSnapshot(
  sessionDir: string,
  snapshot: SessionBackupMetadataSnapshot,
  suffix: string,
  maxEntries?: number,
): Promise<{ dir: string; entries: Map<string, SnapshotTreeEntry> }> {
  const dir = await fs.mkdtemp(path.join(sessionDir, suffix));
  try {
    await restoreSnapshot({ sessionDir, targetDir: dir, snapshot });
    const entries = new Map<string, SnapshotTreeEntry>();
    await collectSnapshotEntries(dir, dir, entries, maxEntries);
    return { dir, entries };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function summarizeSnapshotDelta(opts: {
  sessionDir: string;
  baseline: SessionBackupMetadataSnapshot;
  current: SessionBackupMetadataSnapshot;
  maxFiles?: number;
  maxEntries?: number;
}): Promise<{
  counts: {
    added: number;
    modified: number;
    deleted: number;
  };
  files: WorkspaceBackupDeltaFile[];
  truncated: boolean;
}> {
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles ?? DEFAULT_MAX_FILES));

  let baselineTree: { dir: string; entries: Map<string, SnapshotTreeEntry> } | undefined;
  let currentTree: { dir: string; entries: Map<string, SnapshotTreeEntry> } | undefined;

  try {
    baselineTree = await materializeSnapshot(
      opts.sessionDir,
      opts.baseline,
      ".delta-baseline-",
      opts.maxEntries,
    );
    currentTree = await materializeSnapshot(
      opts.sessionDir,
      opts.current,
      ".delta-current-",
      opts.maxEntries,
    );

    const counts = { added: 0, modified: 0, deleted: 0 };
    const files: WorkspaceBackupDeltaFile[] = [];
    const allPaths = Array.from(
      new Set([...baselineTree.entries.keys(), ...currentTree.entries.keys()]),
    ).sort((left, right) => left.localeCompare(right));

    for (const relativePath of allPaths) {
      const before = baselineTree.entries.get(relativePath);
      const after = currentTree.entries.get(relativePath);
      let change: WorkspaceBackupDeltaFile["change"] | null = null;
      let kind: WorkspaceBackupDeltaFile["kind"] | null = null;

      if (!before && after) {
        change = "added";
        kind = after.kind;
        counts.added += 1;
      } else if (before && !after) {
        change = "deleted";
        kind = before.kind;
        counts.deleted += 1;
      } else if (
        before &&
        after &&
        (before.kind !== after.kind || before.digest !== after.digest)
      ) {
        change = "modified";
        kind = after.kind;
        counts.modified += 1;
      }

      if (!change || !kind) continue;
      if (files.length >= maxFiles) continue;
      files.push({ path: relativePath, change, kind });
    }

    const totalChanges = counts.added + counts.modified + counts.deleted;
    return {
      counts,
      files,
      truncated: totalChanges > files.length,
    };
  } finally {
    if (baselineTree) await fs.rm(baselineTree.dir, { recursive: true, force: true });
    if (currentTree) await fs.rm(currentTree.dir, { recursive: true, force: true });
  }
}
