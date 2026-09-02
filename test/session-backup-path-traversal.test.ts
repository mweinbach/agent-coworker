import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hostPlatform } from "../src/platform/host";
import { SessionBackupManager } from "../src/server/sessionBackup";
import {
  createSnapshotWithTarFallback,
  resolveSnapshotPath,
  restoreSnapshot,
  snapshotByteSize,
} from "../src/server/sessionBackup/snapshot";
import { canonicalizePathForBoundaryCheckSync } from "../src/utils/paths";

async function makeTmpRoot(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `session-backup-traversal-${label}-`));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("session backup snapshot path containment", () => {
  for (const symlinkKind of ["archive", "parent"] as const) {
    test.skipIf(symlinkKind === "archive" && hostPlatform() === "win32")(
      `snapshot creation rejects a dangling ${symlinkKind} symlink before writing`,
      async () => {
        const root = await makeTmpRoot(`dangling-${symlinkKind}`);
        try {
          const sessionDir = path.join(root, "session");
          const sourceDir = path.join(root, "workspace");
          const checkpointsDir = path.join(sessionDir, "checkpoints");
          const outside = path.join(root, "outside");
          await fs.mkdir(sessionDir);
          await fs.mkdir(sourceDir);
          await fs.writeFile(path.join(sourceDir, "notes.txt"), "workspace data");
          if (symlinkKind === "archive") {
            await fs.mkdir(checkpointsDir);
            await fs.symlink(outside, path.join(checkpointsDir, "cp-0002.tar.gz"));
          } else {
            await fs.symlink(outside, checkpointsDir, "junction");
          }
          await expect(
            createSnapshotWithTarFallback({
              sourceDir,
              sessionDir,
              tarPath: "checkpoints/cp-0002.tar.gz",
              directoryPath: "checkpoints/cp-0002",
            }),
          ).rejects.toThrow(/symlink|outside the session directory/);
          expect(await fileExists(outside)).toBe(false);
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      },
    );
  }

  test("snapshot creation cannot write through an escaped checkpoints directory", async () => {
    const root = await makeTmpRoot("symlink-create");
    try {
      const sessionDir = path.join(root, "session");
      const sourceDir = path.join(root, "workspace");
      const external = path.join(root, "external");
      await fs.mkdir(sessionDir);
      await fs.mkdir(sourceDir);
      await fs.mkdir(external);
      await fs.writeFile(path.join(sourceDir, "a.txt"), "workspace data");
      await fs.symlink(external, path.join(sessionDir, "checkpoints"), "junction");
      await expect(
        createSnapshotWithTarFallback({
          sourceDir,
          sessionDir,
          tarPath: "checkpoints/cp-0002.tar.gz",
          directoryPath: "checkpoints/cp-0002",
        }),
      ).rejects.toThrow(/outside the session directory/);
      expect(await fs.readdir(external)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(hostPlatform() === "win32")(
    "restores workspace symlinks without rewriting their relative targets",
    async () => {
      const root = await makeTmpRoot("relative-symlink");
      try {
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace);
        await fs.writeFile(path.join(workspace, "a.txt"), "original");
        await fs.symlink("./a.txt", path.join(workspace, "link.txt"));
        const manager = await SessionBackupManager.create({
          sessionId: crypto.randomUUID(),
          workingDirectory: workspace,
          homedir: path.join(root, "home"),
        });
        await manager.restoreOriginal();
        expect(await fs.readlink(path.join(workspace, "link.txt"))).toBe("./a.txt");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test("snapshot operations reject symlinks that resolve outside the backup root", async () => {
    const root = await makeTmpRoot("symlink");
    try {
      const sessionDir = path.join(root, "session");
      const external = path.join(root, "external");
      const targetDir = path.join(root, "target");
      await fs.mkdir(sessionDir);
      await fs.mkdir(external);
      await fs.mkdir(targetDir);
      await fs.writeFile(path.join(external, "secret.txt"), "external data");
      await fs.symlink(external, path.join(sessionDir, "bridge"), "junction");
      const snapshot = { kind: "directory" as const, path: "bridge" };
      await expect(restoreSnapshot({ sessionDir, targetDir, snapshot })).rejects.toThrow(
        /outside the session directory/,
      );
      await expect(snapshotByteSize(sessionDir, snapshot)).rejects.toThrow(
        /outside the session directory/,
      );
      expect(await fs.readdir(targetDir)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("deleting a tampered checkpoint cannot follow a parent symlink outside the backup", async () => {
    const root = await makeTmpRoot("symlink-delete");
    try {
      const workspace = path.join(root, "workspace");
      const external = path.join(root, "external");
      const victim = path.join(external, "victim");
      await fs.mkdir(workspace);
      await fs.mkdir(victim, { recursive: true });
      await fs.writeFile(path.join(victim, "keep.txt"), "external data");
      const manager = await SessionBackupManager.create({
        sessionId: crypto.randomUUID(),
        workingDirectory: workspace,
        homedir: path.join(root, "home"),
      });
      const checkpoint = await manager.createCheckpoint("manual");
      const sessionDir = manager.getPublicState().backupDirectory!;
      await fs.symlink(external, path.join(sessionDir, "checkpoints", "bridge"), "junction");
      const metadataPath = path.join(sessionDir, "metadata.json");
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
      metadata.checkpoints[1].snapshot = { kind: "directory", path: "checkpoints/bridge/victim" };
      await fs.writeFile(metadataPath, JSON.stringify(metadata));
      const reopened = await SessionBackupManager.openExisting({
        sessionDir,
        homedir: path.join(root, "home"),
      });
      await expect(reopened.deleteCheckpoint(checkpoint.id)).rejects.toThrow(
        /outside the session directory/,
      );
      expect(await fs.readFile(path.join(victim, "keep.txt"), "utf-8")).toBe("external data");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("resolveSnapshotPath accepts contained relative paths and rejects escapes", () => {
    const sessionDir = canonicalizePathForBoundaryCheckSync(path.join(os.tmpdir(), "fake-session"));

    expect(resolveSnapshotPath(sessionDir, "original")).toBe(path.join(sessionDir, "original"));
    expect(resolveSnapshotPath(sessionDir, path.join("checkpoints", "abc.tar.gz"))).toBe(
      path.join(sessionDir, "checkpoints", "abc.tar.gz"),
    );

    expect(() => resolveSnapshotPath(sessionDir, "../escape")).toThrow(
      /outside the session directory/,
    );
    expect(() => resolveSnapshotPath(sessionDir, "checkpoints/../../escape")).toThrow(
      /outside the session directory/,
    );
    expect(() => resolveSnapshotPath(sessionDir, path.resolve("/etc/passwd"))).toThrow(
      /outside the session directory/,
    );
    expect(() => resolveSnapshotPath(sessionDir, ".")).toThrow();
  });

  test("restoreSnapshot refuses to copy a directory from outside the session directory", async () => {
    const root = await makeTmpRoot("restore");
    try {
      const sessionDir = path.join(root, "session");
      const external = path.join(root, "external-secret");
      const targetDir = path.join(root, "target");
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(external, "secret.txt"), "top secret\n", "utf-8");

      const escapingPath = path.relative(sessionDir, external);
      await expect(
        restoreSnapshot({
          sessionDir,
          targetDir,
          snapshot: { kind: "directory", path: escapingPath },
        }),
      ).rejects.toThrow(/outside the session directory/);

      // The external secret must not have been copied into the restore target.
      expect(await fs.readdir(targetDir)).toEqual([]);
      expect(await fileExists(path.join(external, "secret.txt"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("snapshotByteSize refuses to stat an archive outside the session directory", async () => {
    const root = await makeTmpRoot("bytesize");
    try {
      const sessionDir = path.join(root, "session");
      const external = path.join(root, "outside.tar.gz");
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(external, "not really a tar\n", "utf-8");

      const escapingPath = path.relative(sessionDir, external);
      await expect(
        snapshotByteSize(sessionDir, { kind: "tar_gz", path: escapingPath }),
      ).rejects.toThrow(/outside the session directory/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("tampered metadata with an escaping snapshot path fails to load (fail closed)", async () => {
    const root = await makeTmpRoot("metadata");
    try {
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const external = path.join(root, "external-secret");
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");
      await fs.writeFile(path.join(external, "secret.txt"), "top secret\n", "utf-8");

      const manager = await SessionBackupManager.create({
        sessionId: crypto.randomUUID(),
        workingDirectory: workspace,
        homedir: home,
      });
      const sessionDir = manager.getPublicState().backupDirectory;
      if (!sessionDir) throw new Error("Expected backup directory");
      const metadataPath = path.join(sessionDir, "metadata.json");

      // Tamper the protected metadata to point the original snapshot at an
      // external directory via a traversal path, mirroring the reported attack.
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
      metadata.originalSnapshot = {
        kind: "directory",
        path: path.relative(sessionDir, external),
      };
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

      // The tampered metadata must be rejected at load, so no restore/delete can
      // ever act on the attacker-controlled path.
      await expect(
        SessionBackupManager.openExisting({ sessionDir, homedir: home }),
      ).rejects.toThrow();

      // The external secret is untouched and was never copied into the workspace.
      expect(await fileExists(path.join(external, "secret.txt"))).toBe(true);
      expect(await fileExists(path.join(workspace, "secret.txt"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("tampered metadata with an absolute checkpoint snapshot path fails to load", async () => {
    const root = await makeTmpRoot("metadata-abs");
    try {
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "a.txt"), "one\n", "utf-8");

      const manager = await SessionBackupManager.create({
        sessionId: crypto.randomUUID(),
        workingDirectory: workspace,
        homedir: home,
      });
      await fs.writeFile(path.join(workspace, "a.txt"), "two\n", "utf-8");
      const checkpoint = await manager.createCheckpoint("manual");
      const sessionDir = manager.getPublicState().backupDirectory;
      if (!sessionDir) throw new Error("Expected backup directory");
      const metadataPath = path.join(sessionDir, "metadata.json");

      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
      const target = metadata.checkpoints.find((cp: { id: string }) => cp.id === checkpoint.id);
      target.snapshot = { kind: "directory", path: path.resolve(root, "external-delete-target") };
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

      await expect(
        SessionBackupManager.openExisting({ sessionDir, homedir: home }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
