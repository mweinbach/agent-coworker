import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionBackupManager } from "../src/server/sessionBackup";

async function makeTmpWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-backup-test-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  return { root, home, workspace };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("SessionBackupManager", () => {
  test("creates original snapshot and restores original/checkpoint states", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.mkdir(path.join(workspace, "sub"), { recursive: true });
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");
    await fs.writeFile(path.join(workspace, "sub", "b.txt"), "orig\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: crypto.randomUUID(),
      workingDirectory: workspace,
      homedir: home,
    });

    await fs.writeFile(path.join(workspace, "a.txt"), "two\n", "utf-8");
    await fs.writeFile(path.join(workspace, "new.txt"), "new\n", "utf-8");
    await fs.rm(path.join(workspace, "sub", "b.txt"), { force: true });

    const checkpoint = await manager.createCheckpoint("auto");
    expect(checkpoint.changed).toBe(true);

    if (process.platform !== "win32") {
      const backupDir = manager.getPublicState().backupDirectory;
      expect(backupDir).toBeDefined();
      if (backupDir) {
        const backupSt = await fs.stat(backupDir);
        expect(backupSt.mode & 0o777).toBe(0o700);

        const metadataSt = await fs.stat(path.join(backupDir, "metadata.json"));
        expect(metadataSt.mode & 0o777).toBe(0o600);

        const patchSt = await fs.stat(path.join(backupDir, "checkpoints", `${checkpoint.id}.patch.gz`));
        expect(patchSt.mode & 0o777).toBe(0o600);
      }
    }

    await fs.writeFile(path.join(workspace, "a.txt"), "three\n", "utf-8");
    await fs.rm(path.join(workspace, "new.txt"), { force: true });
    await fs.writeFile(path.join(workspace, "sub", "b.txt"), "different\n", "utf-8");

    await manager.restoreCheckpoint(checkpoint.id);
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("two\n");
    expect(await fs.readFile(path.join(workspace, "new.txt"), "utf-8")).toBe("new\n");
    expect(await fileExists(path.join(workspace, "sub", "b.txt"))).toBe(false);

    await manager.restoreOriginal();
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("one\n");
    expect(await fs.readFile(path.join(workspace, "sub", "b.txt"), "utf-8")).toBe("orig\n");
    expect(await fileExists(path.join(workspace, "new.txt"))).toBe(false);
  });

  test("deleteCheckpoint removes stored checkpoint", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: crypto.randomUUID(),
      workingDirectory: workspace,
      homedir: home,
    });

    await fs.writeFile(path.join(workspace, "a.txt"), "two\n", "utf-8");
    const checkpoint = await manager.createCheckpoint("manual");
    expect(manager.getPublicState().checkpoints).toHaveLength(1);

    const removed = await manager.deleteCheckpoint(checkpoint.id);
    expect(removed).toBe(true);
    expect(manager.getPublicState().checkpoints).toHaveLength(0);

    const removedAgain = await manager.deleteCheckpoint(checkpoint.id);
    expect(removedAgain).toBe(false);
  });

  test("compactClosedSessions compresses closed originals", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");

    const sessionId = crypto.randomUUID();
    const manager = await SessionBackupManager.create({
      sessionId,
      workingDirectory: workspace,
      homedir: home,
    });
    await manager.close();

    const backupsRoot = path.join(home, ".cowork", "session-backups");
    const sessionDir = path.join(backupsRoot, sessionId);
    const originalDir = path.join(sessionDir, "original");
    const originalArchive = path.join(sessionDir, "original.tar.gz");

    expect(await fileExists(originalDir)).toBe(true);
    await SessionBackupManager.compactClosedSessions(backupsRoot);
    expect(await fileExists(originalArchive)).toBe(true);
    expect(await fileExists(originalDir)).toBe(false);
  });
});
