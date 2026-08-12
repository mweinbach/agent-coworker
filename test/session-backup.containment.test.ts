import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../src/platform/sandbox";
import { SessionBackupManager } from "../src/server/sessionBackup";

async function makeTmpWorkspace() {
  const root = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", "session-backup-containment-"),
  );
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  return { root, home, workspace };
}

describe("SessionBackupManager containment guards", () => {
  test("refuses to create a backup whose directory would sit inside the working directory", async () => {
    const { home } = await makeTmpWorkspace();
    // Place the working directory at a common ancestor of both the default
    // ~/.cowork/session-backups root and the tmp fallback root. That forces
    // resolveSessionBackupsRootDir onto the fallback, which still lands inside WD.
    const workingDirectory = scratchRoots()[0] ?? "/tmp";

    await expect(
      SessionBackupManager.create({
        sessionId: crypto.randomUUID(),
        workingDirectory,
        homedir: home,
      }),
    ).rejects.toThrow(
      `Refusing to create session backup inside working directory: ${path.resolve(workingDirectory)}`,
    );
  });

  test("refuses to reuse a backup directory with a mismatched session id", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "note.txt"), "keep\n", "utf-8");
    const sessionId = crypto.randomUUID();

    const manager = await SessionBackupManager.create({
      sessionId,
      workingDirectory: workspace,
      homedir: home,
    });
    const backupDirectory = manager.getPublicState().backupDirectory;
    expect(backupDirectory).toBeTruthy();
    if (!backupDirectory) throw new Error("expected backup directory");

    const metadataPath = path.join(backupDirectory, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8")) as Record<
      string,
      unknown
    >;
    metadata.sessionId = crypto.randomUUID();
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    await expect(
      SessionBackupManager.create({
        sessionId,
        workingDirectory: workspace,
        homedir: home,
      }),
    ).rejects.toThrow(`Refusing to reuse backup with mismatched session id at ${metadataPath}`);
  });

  test("refuses restore when metadata claims a working directory that contains the backup", async () => {
    const { home, workspace } = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "note.txt"), "original\n", "utf-8");
    const sessionId = crypto.randomUUID();

    const manager = await SessionBackupManager.create({
      sessionId,
      workingDirectory: workspace,
      homedir: home,
    });
    const checkpoint = await manager.createCheckpoint("manual");
    const backupDirectory = manager.getPublicState().backupDirectory;
    expect(backupDirectory).toBeTruthy();
    if (!backupDirectory) throw new Error("expected backup directory");

    const metadataPath = path.join(backupDirectory, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8")) as Record<
      string,
      unknown
    >;
    // Ancestor of sessionDir → restore must refuse before applying any snapshot.
    metadata.workingDirectory = path.dirname(backupDirectory);
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    const poisoned = await SessionBackupManager.openExisting({
      sessionDir: backupDirectory,
      reopen: true,
    });

    await fs.writeFile(path.join(workspace, "note.txt"), "mutated\n", "utf-8");

    await expect(poisoned.restoreOriginal()).rejects.toThrow(
      "Refusing to restore: backup directory is inside the working directory",
    );
    await expect(poisoned.restoreCheckpoint(checkpoint.id)).rejects.toThrow(
      "Refusing to restore: backup directory is inside the working directory",
    );
    expect(await fs.readFile(path.join(workspace, "note.txt"), "utf-8")).toBe("mutated\n");
  });
});
