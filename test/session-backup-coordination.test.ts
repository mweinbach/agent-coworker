import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../src/platform/sandbox";
import { SessionBackupManager } from "../src/server/sessionBackup";
import { WorkspaceBackupService } from "../src/server/workspaceBackups";
import { fileLockRootForCoworkHome, withFileLock } from "../src/utils/fileLock";

const repoRoot = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "backup-coordination-"));
  roots.push(root);
  const homedir = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "notes.txt"), "original");
  const manager = await SessionBackupManager.create({
    sessionId: "shared",
    workingDirectory: workspace,
    homedir,
  });
  const service = new WorkspaceBackupService({
    homedir,
    sessionDb: null,
    getLiveSession: () => null,
  });
  return {
    root,
    homedir,
    workspace,
    manager,
    service,
    sessionDir: manager.getPublicState().backupDirectory!,
    lockRoot: fileLockRootForCoworkHome(path.join(homedir, ".cowork")),
  };
}

async function spawnWorker(root: string, source: string, args: string[]) {
  const script = path.join(root, `${crypto.randomUUID()}.ts`);
  await fs.writeFile(script, source);
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function waitForFile(file: string, child: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await fs.stat(file).catch(() => null)) return;
    const exitCode = await Promise.race([child.exited, Bun.sleep(10).then(() => null)]);
    if (exitCode !== null) {
      throw new Error(`worker exited ${exitCode}: ${await new Response(child.stderr).text()}`);
    }
  }
  throw new Error("worker did not reach the filesystem barrier");
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited.catch(() => {});
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("backup process and workspace coordination", () => {
  test("retained legacy rollback files stay visible and prevent destructive backup cleanup", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "notes.txt"), "checkpoint before recovery");
    const checkpoint = await f.manager.createCheckpoint("manual");
    const recovery = path.join(f.workspace, ".restore-rollback-legacy");
    await fs.mkdir(recovery);
    await fs.writeFile(path.join(recovery, "original.txt"), "retained original");
    const metadataPath = path.join(f.sessionDir, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
    metadata.state = "closed";
    metadata.closedAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    const [entry] = await f.service.listWorkspaceBackups(f.workspace);
    expect(entry.failureReason).toContain(recovery);
    await expect(f.manager.deleteCheckpoint(checkpoint.id)).rejects.toThrow("Recovery required");
    expect(f.manager.getPublicState().checkpoints.some((item) => item.id === checkpoint.id)).toBe(
      true,
    );
    await expect(f.service.deleteEntry(f.workspace, "shared")).rejects.toThrow("Recovery required");
    await SessionBackupManager.pruneBackupsRoot(path.dirname(f.sessionDir), { homedir: f.homedir });
    expect((await fs.stat(f.sessionDir)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(recovery, "original.txt"), "utf-8")).toBe(
      "retained original",
    );
    expect((await f.manager.reloadFromDisk()).status).toBe("failed");
  });

  test("pruning rechecks metadata after a competing lock holder refreshes the backup", async () => {
    const f = await fixture();
    const metadataPath = path.join(f.sessionDir, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
    const old = new Date("2000-01-01T00:00:00.000Z");
    metadata.createdAt = old.toISOString();
    metadata.checkpoints[0].createdAt = old.toISOString();
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    await fs.utimes(metadataPath, old, old);
    let entered!: () => void;
    let release!: () => void;
    const enteredLock = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(
      f.sessionDir,
      async () => {
        entered();
        await releaseLock;
      },
      { lockRoot: f.lockRoot },
    );
    await enteredLock;
    const readFile = fs.readFile;
    let observed!: () => void;
    let continueRead!: () => void;
    const didObserve = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const mayRead = new Promise<void>((resolve) => {
      continueRead = resolve;
    });
    let gated = false;
    const read = spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      const value = await readFile(target, options);
      if (!gated && String(target) === metadataPath) {
        gated = true;
        observed();
        await mayRead;
      }
      return value;
    });
    const pruning = SessionBackupManager.pruneBackupsRoot(path.dirname(f.sessionDir), {
      homedir: f.homedir,
    });
    try {
      await didObserve;
      metadata.createdAt = new Date().toISOString();
      metadata.checkpoints[0].createdAt = metadata.createdAt;
      await fs.writeFile(metadataPath, JSON.stringify(metadata));
      continueRead();
      release();
      await holder;
      await pruning;
      expect((await fs.stat(f.sessionDir)).isDirectory()).toBe(true);
    } finally {
      continueRead();
      release();
      await holder;
      await pruning;
      read.mockRestore();
    }
  });

  test("tampered workspace identity cannot reenter the same session lock", async () => {
    const f = await fixture();
    const metadataPath = path.join(f.sessionDir, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
    metadata.workingDirectory = f.sessionDir;
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    await expect(f.manager.reloadFromDisk()).rejects.toThrow("inside the working directory");
  });

  test("a checkpoint holds the shared process lock and another server retains its own checkpoint", async () => {
    const f = await fixture();
    const ready = path.join(f.root, "ready");
    const release = path.join(f.root, "release");
    const child = await spawnWorker(
      f.root,
      [
        'import fs from "node:fs/promises";',
        `import { WorkspaceBackupService } from ${JSON.stringify(path.join(repoRoot, "src/server/workspaceBackups.ts"))};`,
        "const [workspace, homedir, ready, release] = process.argv.slice(2);",
        "const readdir = fs.readdir;",
        "let gated = false;",
        "fs.readdir = async (target, options) => {",
        "  if (!gated && String(target) === workspace) {",
        "    gated = true;",
        '    await fs.writeFile(ready, "ready");',
        "    while (!await fs.stat(release).catch(() => null)) await Bun.sleep(5);",
        "  }",
        "  return readdir(target, options);",
        "};",
        'await new WorkspaceBackupService({ homedir, sessionDb: null, getLiveSession: () => null }).createCheckpoint(workspace, "shared");',
      ].join("\n"),
      [f.workspace, f.homedir, ready, release],
    );
    await waitForFile(ready, child);
    try {
      await expect(
        withFileLock(f.sessionDir, async () => {}, {
          lockRoot: f.lockRoot,
          acquireTimeoutMs: 50,
          retryDelayMs: 5,
        }),
      ).rejects.toThrow("Timed out acquiring file lock");
      const second = f.service.createCheckpoint(f.workspace, "shared");
      await fs.writeFile(release, "release");
      expect(await child.exited).toBe(0);
      await second;
      await f.manager.reloadFromDisk();
      expect(f.manager.getPublicState().checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
        "cp-0001",
        "cp-0002",
        "cp-0003",
      ]);
    } finally {
      await fs.writeFile(release, "release");
    }
  });

  test("different session restores serialize the workspace and cannot consume each other's rollback", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "notes.txt"), "second snapshot");
    const second = await SessionBackupManager.create({
      sessionId: "second",
      workingDirectory: f.workspace,
      homedir: f.homedir,
    });
    await fs.writeFile(path.join(f.workspace, "notes.txt"), "latest");
    await fs.writeFile(path.join(f.workspace, "unsaved.txt"), "uncheckpointed");
    const cp = fs.cp;
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const copy = spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      if (String(source).includes(`${path.sep}shared${path.sep}.restore-stage-`)) {
        entered();
        await mayFinish;
        throw new Error("injected restore failure");
      }
      await cp(source, destination, options);
    });
    const firstRestore = f.manager.restoreOriginal().then(
      () => null,
      (error) => error,
    );
    try {
      await didEnter;
      await expect(
        withFileLock(f.workspace, async () => {}, {
          lockRoot: f.lockRoot,
          acquireTimeoutMs: 50,
          retryDelayMs: 5,
        }),
      ).rejects.toThrow("Timed out acquiring file lock");
      const nextRestore = second.restoreOriginal();
      release();
      expect(String(await firstRestore)).toBe("Error: injected restore failure");
      await nextRestore;
      expect(await fs.readFile(path.join(f.workspace, "notes.txt"), "utf-8")).toBe(
        "second snapshot",
      );
      expect(
        (await fs.readdir(f.workspace)).some((name) => name.startsWith(".restore-rollback-")),
      ).toBe(false);
    } finally {
      release();
      await firstRestore;
      copy.mockRestore();
    }
  });

  test("a killed restore exposes retained recovery files and refuses to overwrite newer edits", async () => {
    const f = await fixture();
    const notes = path.join(f.workspace, "notes.txt");
    await fs.writeFile(notes, "uncheckpointed before crash");
    const child = await spawnWorker(
      f.root,
      [
        'import fs from "node:fs/promises";',
        `import { SessionBackupManager } from ${JSON.stringify(path.join(repoRoot, "src/server/sessionBackup.ts"))};`,
        "const manager = await SessionBackupManager.openExisting({ sessionDir: process.argv[2], homedir: process.argv[3] });",
        "const cp = fs.cp;",
        "fs.cp = async (source, destination, options) => {",
        '  if (String(source).includes(".restore-stage-")) process.exit(97);',
        "  return cp(source, destination, options);",
        "};",
        "await manager.restoreOriginal();",
      ].join("\n"),
      [f.sessionDir, f.homedir],
    );
    expect(await child.exited).toBe(97);
    const [entry] = await f.service.listWorkspaceBackups(f.workspace);
    expect(entry.status).toBe("failed");
    const recoveryName = (await fs.readdir(f.workspace)).find((name) =>
      name.startsWith(".restore-rollback-"),
    );
    expect(recoveryName).toBeDefined();
    const recoveryDir = path.join(f.workspace, recoveryName!);
    expect(entry.failureReason).toContain(recoveryDir);
    const journal = JSON.parse(await fs.readFile(path.join(recoveryDir, "recovery.json"), "utf-8"));
    expect(journal.phase).toBe("restoring");
    const retainedNotes = path.join(recoveryDir, "files", "notes.txt");
    expect(await fs.readFile(retainedNotes, "utf-8")).toBe("uncheckpointed before crash");
    await fs.writeFile(notes, "newer edits after crash");
    await expect(f.manager.restoreOriginal()).rejects.toThrow("Recovery required");
    await expect(f.service.createCheckpoint(f.workspace, "shared")).rejects.toThrow(
      "Recovery required",
    );
    expect(await fs.readFile(notes, "utf-8")).toBe("newer edits after crash");
    expect(await fs.readFile(retainedNotes, "utf-8")).toBe("uncheckpointed before crash");
  });
});
