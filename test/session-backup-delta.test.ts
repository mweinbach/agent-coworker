import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { summarizeSnapshotDelta } from "../src/server/sessionBackup/delta";
import type { SessionBackupMetadataSnapshot } from "../src/server/sessionBackup/metadata";

const tmpRoots: string[] = [];

async function makeTmpSessionDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "delta-test-"));
  tmpRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})));
});

async function writeDirectorySnapshot(
  sessionDir: string,
  snapshotName: string,
  files: Record<string, string>,
): Promise<SessionBackupMetadataSnapshot> {
  const snapshotDir = path.join(sessionDir, snapshotName);
  await fs.mkdir(snapshotDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(snapshotDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }
  return { kind: "directory", path: snapshotName };
}

describe("summarizeSnapshotDelta", () => {
  test("detects added, modified, and deleted files", async () => {
    const sessionDir = await makeTmpSessionDir();

    const baseline = await writeDirectorySnapshot(sessionDir, "baseline", {
      "a.txt": "hello",
      "b.txt": "world",
      "sub/c.txt": "nested",
    });

    const current = await writeDirectorySnapshot(sessionDir, "current", {
      "a.txt": "hello",
      "b.txt": "changed",
      "sub/d.txt": "new-file",
    });

    const result = await summarizeSnapshotDelta({ sessionDir, baseline, current });

    expect(result.counts.added).toBe(1);
    expect(result.counts.modified).toBe(1);
    expect(result.counts.deleted).toBe(1);
    expect(result.truncated).toBe(false);

    const added = result.files.find((f) => f.change === "added");
    expect(added?.path).toBe("sub/d.txt");
    expect(added?.kind).toBe("file");

    const modified = result.files.find((f) => f.change === "modified");
    expect(modified?.path).toBe("b.txt");

    const deleted = result.files.find((f) => f.change === "deleted");
    expect(deleted?.path).toBe("sub/c.txt");
  });

  test("returns empty delta for identical snapshots", async () => {
    const sessionDir = await makeTmpSessionDir();

    const baseline = await writeDirectorySnapshot(sessionDir, "baseline", {
      "a.txt": "same",
      "b.txt": "same",
    });

    const current = await writeDirectorySnapshot(sessionDir, "current", {
      "a.txt": "same",
      "b.txt": "same",
    });

    const result = await summarizeSnapshotDelta({ sessionDir, baseline, current });

    expect(result.counts.added).toBe(0);
    expect(result.counts.modified).toBe(0);
    expect(result.counts.deleted).toBe(0);
    expect(result.files).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  test("truncates file list when exceeding maxFiles", async () => {
    const sessionDir = await makeTmpSessionDir();

    const baselineFiles: Record<string, string> = {};
    const currentFiles: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      currentFiles[`new-${i}.txt`] = `content-${i}`;
    }

    const baseline = await writeDirectorySnapshot(sessionDir, "baseline", baselineFiles);
    const current = await writeDirectorySnapshot(sessionDir, "current", currentFiles);

    const result = await summarizeSnapshotDelta({ sessionDir, baseline, current, maxFiles: 3 });

    expect(result.counts.added).toBe(10);
    expect(result.files).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  test("handles empty baseline (all files added)", async () => {
    const sessionDir = await makeTmpSessionDir();

    const baseline = await writeDirectorySnapshot(sessionDir, "baseline", {});
    const current = await writeDirectorySnapshot(sessionDir, "current", {
      "a.txt": "new",
      "b.txt": "new",
    });

    const result = await summarizeSnapshotDelta({ sessionDir, baseline, current });

    expect(result.counts.added).toBe(2);
    expect(result.counts.modified).toBe(0);
    expect(result.counts.deleted).toBe(0);
  });

  test("handles empty current (all files deleted)", async () => {
    const sessionDir = await makeTmpSessionDir();

    const baseline = await writeDirectorySnapshot(sessionDir, "baseline", {
      "a.txt": "old",
      "b.txt": "old",
    });
    const current = await writeDirectorySnapshot(sessionDir, "current", {});

    const result = await summarizeSnapshotDelta({ sessionDir, baseline, current });

    expect(result.counts.added).toBe(0);
    expect(result.counts.modified).toBe(0);
    expect(result.counts.deleted).toBe(2);
  });

  test("files are sorted by path", async () => {
    const sessionDir = await makeTmpSessionDir();

    const baseline = await writeDirectorySnapshot(sessionDir, "baseline", {});
    const current = await writeDirectorySnapshot(sessionDir, "current", {
      "z.txt": "z",
      "a.txt": "a",
      "m/nested.txt": "m",
    });

    const result = await summarizeSnapshotDelta({ sessionDir, baseline, current });

    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual(["a.txt", "m/nested.txt", "z.txt"]);
  });
});
