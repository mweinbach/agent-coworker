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

    const backupState = manager.getPublicState();
    const backupDir = backupState.backupDirectory;
    expect(backupDir).toBeDefined();
    if (backupDir && process.platform !== "win32") {
      const backupSt = await fs.stat(backupDir);
      expect(backupSt.mode & 0o777).toBe(0o700);

      const metadataSt = await fs.stat(path.join(backupDir, "metadata.json"));
      expect(metadataSt.mode & 0o777).toBe(0o600);

      if (backupState.originalSnapshot.kind === "tar_gz") {
        const originalSt = await fs.stat(path.join(backupDir, "original.tar.gz"));
        expect(originalSt.mode & 0o777).toBe(0o600);
      } else {
        expect(await fileExists(path.join(backupDir, "original"))).toBe(true);
      }
    }

    await fs.writeFile(path.join(workspace, "a.txt"), "two\n", "utf-8");
    await fs.writeFile(path.join(workspace, "new.txt"), "new\n", "utf-8");
    await fs.rm(path.join(workspace, "sub", "b.txt"), { force: true });

    const checkpoint = await manager.createCheckpoint("auto");
    expect(checkpoint.changed).toBe(true);
    expect(checkpoint.patchBytes).toBeGreaterThan(0);

    if (backupDir && process.platform !== "win32") {
      const tarCheckpointPath = path.join(backupDir, "checkpoints", `${checkpoint.id}.tar.gz`);
      if (await fileExists(tarCheckpointPath)) {
        const cpSt = await fs.stat(tarCheckpointPath);
        expect(cpSt.mode & 0o777).toBe(0o600);
      } else {
        expect(await fileExists(path.join(backupDir, "checkpoints", checkpoint.id))).toBe(true);
      }
    }

    // Modify files further, then restore checkpoint.
    await fs.writeFile(path.join(workspace, "a.txt"), "three\n", "utf-8");
    await fs.rm(path.join(workspace, "new.txt"), { force: true });
    await fs.writeFile(path.join(workspace, "sub", "b.txt"), "different\n", "utf-8");

    await manager.restoreCheckpoint(checkpoint.id);
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("two\n");
    expect(await fs.readFile(path.join(workspace, "new.txt"), "utf-8")).toBe("new\n");
    expect(await fileExists(path.join(workspace, "sub", "b.txt"))).toBe(false);

    // Restore to original state.
    await manager.restoreOriginal();
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("one\n");
    expect(await fs.readFile(path.join(workspace, "sub", "b.txt"), "utf-8")).toBe("orig\n");
    expect(await fileExists(path.join(workspace, "new.txt"))).toBe(false);
  });

  test("falls back to directory snapshots when tar is unavailable", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.mkdir(path.join(workspace, "sub"), { recursive: true });
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");
    await fs.writeFile(path.join(workspace, "sub", "b.txt"), "orig\n", "utf-8");

    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const previousPath = process.env[pathKey];
    process.env[pathKey] = "";

    try {
      const manager = await SessionBackupManager.create({
        sessionId: crypto.randomUUID(),
        workingDirectory: workspace,
        homedir: home,
      });

      const backupState = manager.getPublicState();
      const backupDir = backupState.backupDirectory;
      expect(backupState.originalSnapshot.kind).toBe("directory");
      expect(backupDir).toBeDefined();
      if (!backupDir) throw new Error("Expected backup directory");
      expect(await fileExists(path.join(backupDir, "original"))).toBe(true);

      await fs.writeFile(path.join(workspace, "a.txt"), "two\n", "utf-8");
      const checkpoint = await manager.createCheckpoint("manual");
      expect(checkpoint.changed).toBe(true);
      expect(checkpoint.patchBytes).toBeGreaterThan(0);

      expect(await fileExists(path.join(backupDir, "checkpoints", checkpoint.id))).toBe(true);
      expect(await fileExists(path.join(backupDir, "checkpoints", `${checkpoint.id}.tar.gz`))).toBe(false);

      await fs.writeFile(path.join(workspace, "a.txt"), "three\n", "utf-8");
      await fs.writeFile(path.join(workspace, "new.txt"), "new\n", "utf-8");

      await manager.restoreCheckpoint(checkpoint.id);
      expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("two\n");
      expect(await fileExists(path.join(workspace, "new.txt"))).toBe(false);

      await manager.restoreOriginal();
      expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("one\n");
      expect(await fs.readFile(path.join(workspace, "sub", "b.txt"), "utf-8")).toBe("orig\n");
    } finally {
      if (previousPath === undefined) {
        delete process.env[pathKey];
      } else {
        process.env[pathKey] = previousPath;
      }
    }
  });

  test("createCheckpoint skips snapshot creation when workspace is unchanged", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: crypto.randomUUID(),
      workingDirectory: workspace,
      homedir: home,
    });

    const backupState = manager.getPublicState();
    if (!backupState.backupDirectory) throw new Error("Expected backup directory");

    const checkpoint = await manager.createCheckpoint("auto");
    expect(checkpoint.changed).toBe(false);
    expect(checkpoint.patchBytes).toBe(0);
    expect(await fileExists(path.join(backupState.backupDirectory, "checkpoints", `${checkpoint.id}.tar.gz`))).toBe(false);
    expect(await fileExists(path.join(backupState.backupDirectory, "checkpoints", checkpoint.id))).toBe(false);

    await fs.writeFile(path.join(workspace, "a.txt"), "mutated\n", "utf-8");
    await manager.restoreCheckpoint(checkpoint.id);
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("one\n");
  });

  test("deleteCheckpoint preserves shared snapshot artifacts until last reference is removed", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: crypto.randomUUID(),
      workingDirectory: workspace,
      homedir: home,
    });

    await fs.writeFile(path.join(workspace, "a.txt"), "two\n", "utf-8");
    const changedCheckpoint = await manager.createCheckpoint("manual");
    expect(changedCheckpoint.changed).toBe(true);

    const backupState = manager.getPublicState();
    if (!backupState.backupDirectory) throw new Error("Expected backup directory");
    const sharedTarPath = path.join(backupState.backupDirectory, "checkpoints", `${changedCheckpoint.id}.tar.gz`);
    const sharedDirPath = path.join(backupState.backupDirectory, "checkpoints", changedCheckpoint.id);
    expect((await fileExists(sharedTarPath)) || (await fileExists(sharedDirPath))).toBe(true);

    const unchangedCheckpoint = await manager.createCheckpoint("auto");
    expect(unchangedCheckpoint.changed).toBe(false);
    expect(unchangedCheckpoint.patchBytes).toBe(0);
    expect(await fileExists(path.join(backupState.backupDirectory, "checkpoints", `${unchangedCheckpoint.id}.tar.gz`))).toBe(false);
    expect(await fileExists(path.join(backupState.backupDirectory, "checkpoints", unchangedCheckpoint.id))).toBe(false);

    const removedChanged = await manager.deleteCheckpoint(changedCheckpoint.id);
    expect(removedChanged).toBe(true);
    expect((await fileExists(sharedTarPath)) || (await fileExists(sharedDirPath))).toBe(true);

    await fs.writeFile(path.join(workspace, "a.txt"), "three\n", "utf-8");
    await manager.restoreCheckpoint(unchangedCheckpoint.id);
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("two\n");

    const removedUnchanged = await manager.deleteCheckpoint(unchangedCheckpoint.id);
    expect(removedUnchanged).toBe(true);
    expect(await fileExists(sharedTarPath)).toBe(false);
    expect(await fileExists(sharedDirPath)).toBe(false);
  });

  test("restoreOriginal does not clear workspace when original snapshot is missing", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");
    await fs.writeFile(path.join(workspace, "keep.txt"), "keep\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: crypto.randomUUID(),
      workingDirectory: workspace,
      homedir: home,
    });

    await fs.writeFile(path.join(workspace, "a.txt"), "mutated\n", "utf-8");
    await fs.writeFile(path.join(workspace, "keep.txt"), "still-here\n", "utf-8");

    const backupState = manager.getPublicState();
    if (!backupState.backupDirectory) throw new Error("Expected backup directory");
    const originalArtifactPath =
      backupState.originalSnapshot.kind === "tar_gz"
        ? path.join(backupState.backupDirectory, "original.tar.gz")
        : path.join(backupState.backupDirectory, "original");
    await fs.rm(originalArtifactPath, { recursive: true, force: true });

    await expect(manager.restoreOriginal()).rejects.toThrow();
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("mutated\n");
    expect(await fs.readFile(path.join(workspace, "keep.txt"), "utf-8")).toBe("still-here\n");
  });

  test("restoreCheckpoint does not clear workspace when checkpoint snapshot is missing", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: crypto.randomUUID(),
      workingDirectory: workspace,
      homedir: home,
    });

    await fs.writeFile(path.join(workspace, "a.txt"), "checkpoint\n", "utf-8");
    const checkpoint = await manager.createCheckpoint("manual");

    await fs.writeFile(path.join(workspace, "a.txt"), "latest\n", "utf-8");
    await fs.writeFile(path.join(workspace, "keep.txt"), "keep\n", "utf-8");

    const backupState = manager.getPublicState();
    if (!backupState.backupDirectory) throw new Error("Expected backup directory");
    await fs.rm(path.join(backupState.backupDirectory, "checkpoints", `${checkpoint.id}.tar.gz`), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(backupState.backupDirectory, "checkpoints", checkpoint.id), {
      recursive: true,
      force: true,
    });

    await expect(manager.restoreCheckpoint(checkpoint.id)).rejects.toThrow();
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf-8")).toBe("latest\n");
    expect(await fs.readFile(path.join(workspace, "keep.txt"), "utf-8")).toBe("keep\n");
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

  test("pruneClosedSessions removes old closed sessions beyond retention", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sessionId = crypto.randomUUID();
      ids.push(sessionId);
      const manager = await SessionBackupManager.create({
        sessionId,
        workingDirectory: workspace,
        homedir: home,
      });
      await manager.close();
    }

    const backupsRoot = path.join(home, ".cowork", "session-backups");
    await SessionBackupManager.pruneClosedSessions(backupsRoot, { maxClosedSessions: 1, maxClosedAgeDays: 365 });

    const existing = await Promise.all(ids.map(async (id) => ({ id, exists: await fileExists(path.join(backupsRoot, id)) })));
    expect(existing.filter((x) => x.exists).length).toBe(1);
  });
});
