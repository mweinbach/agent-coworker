import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../src/platform/sandbox";
import { readMetadata } from "../src/server/sessionBackup/metadata";

const CONTAINED_PATH_MESSAGE =
  "snapshot path must be a relative path contained within the backup session directory";

function metadata(originalPath: string, checkpointPath = "checkpoints/cp-0001.tar.gz") {
  return {
    version: 1,
    sessionId: "session-1",
    workingDirectory: "/work/app",
    createdAt: "2026-10-30T00:00:00.000Z",
    state: "active",
    originalSnapshot: { kind: "directory", path: originalPath },
    checkpoints: [
      {
        id: "cp-1",
        index: 0,
        createdAt: "2026-10-30T00:00:01.000Z",
        trigger: "auto",
        changed: false,
        patchBytes: 0,
        fingerprint: "fingerprint-1",
        snapshot: { kind: "tar_gz", path: checkpointPath },
      },
    ],
  };
}

async function writeMetadata(dir: string, value: unknown): Promise<string> {
  const filePath = path.join(dir, "metadata.json");
  const raw = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  await fs.writeFile(filePath, raw);
  return filePath;
}

describe("session backup metadata snapshot paths", () => {
  test("loads contained relative snapshot paths, including the other separator and dot lookalikes", async () => {
    const [scratchRoot] = scratchRoots();
    if (!scratchRoot) throw new Error("scratch root is required");
    const dir = await fs.mkdtemp(path.join(scratchRoot, "backup-meta-ok-"));
    try {
      const contained = [
        "checkpoints/cp-0001",
        "checkpoints\\cp-0001",
        "checkpoints/.../notes.txt",
        "checkpoints/..hidden/notes.txt",
      ];
      for (const originalPath of contained) {
        const filePath = await writeMetadata(dir, metadata(originalPath));
        const loaded = await readMetadata(filePath);
        expect(loaded?.originalSnapshot.path).toBe(originalPath);
        expect(loaded?.checkpoints[0]?.snapshot.path).toBe("checkpoints/cp-0001.tar.gz");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects cross-separator, drive-letter, and absolute snapshot paths", async () => {
    const [scratchRoot] = scratchRoots();
    if (!scratchRoot) throw new Error("scratch root is required");
    const dir = await fs.mkdtemp(path.join(scratchRoot, "backup-meta-bad-"));
    try {
      const escaped = [
        "checkpoints\\..\\escape",
        "checkpoints/../escape",
        "checkpoints/foo/../cp-0001",
        "\\\\server\\share",
        "/etc/passwd",
        "C:evil\\snap",
        "c:/windows/system32",
      ];
      for (const originalPath of escaped) {
        const filePath = await writeMetadata(dir, metadata(originalPath));
        await expect(readMetadata(filePath)).rejects.toThrow(CONTAINED_PATH_MESSAGE);
      }

      const checkpointEscape = await writeMetadata(
        dir,
        metadata("checkpoints/cp-0001", "checkpoints\\..\\escape"),
      );
      await expect(readMetadata(checkpointEscape)).rejects.toThrow(CONTAINED_PATH_MESSAGE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null for a missing file and rejects invalid JSON", async () => {
    const [scratchRoot] = scratchRoots();
    if (!scratchRoot) throw new Error("scratch root is required");
    const dir = await fs.mkdtemp(path.join(scratchRoot, "backup-meta-io-"));
    try {
      const missing = path.join(dir, "missing.json");
      expect(await readMetadata(missing)).toBeNull();

      const invalid = await writeMetadata(dir, "{");
      await expect(readMetadata(invalid)).rejects.toThrow(
        `Invalid backup metadata JSON at ${invalid}`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
