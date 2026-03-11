import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PersistedSessionRecord } from "../src/server/sessionDb";
import { SessionBackupManager } from "../src/server/sessionBackup";
import { readMetadata } from "../src/server/sessionBackup/metadata";
import { WorkspaceBackupService } from "../src/server/workspaceBackups";

const tmpRoots: string[] = [];

async function makeTmpWorkspaces() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-backups-test-"));
  tmpRoots.push(root);
  const home = path.join(root, "home");
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });
  return { root, home, workspaceA, workspaceB };
}

function makeSessionRecord(sessionId: string, status: PersistedSessionRecord["status"]): PersistedSessionRecord {
  return {
    sessionId,
    sessionKind: "root",
    parentSessionId: null,
    agentType: null,
    title: `Session ${sessionId}`,
    titleSource: "manual",
    titleModel: null,
    provider: "openai",
    model: "gpt-5.2",
    workingDirectory: "/unused",
    enableMcp: true,
    backupsEnabledOverride: null,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:10:00.000Z",
    status,
    hasPendingAsk: false,
    hasPendingApproval: false,
    messageCount: 0,
    lastEventSeq: 0,
    systemPrompt: "",
    messages: [],
    providerState: null,
    todos: [],
    harnessContext: null,
    costTracker: null,
  };
}

function makeService(opts: {
  home: string;
  records?: Record<string, PersistedSessionRecord>;
  live?: Record<string, { busy: boolean; status: PersistedSessionRecord["status"] }>;
}) {
  return new WorkspaceBackupService({
    homedir: opts.home,
    sessionDb: {
      getSessionRecord: (sessionId: string) => opts.records?.[sessionId] ?? null,
    } as any,
    getLiveSession: (sessionId: string) => {
      const live = opts.live?.[sessionId];
      if (!live) return null;
      return {
        sessionId,
        title: `Live ${sessionId}`,
        provider: "openai",
        model: "gpt-5.2",
        updatedAt: "2026-03-10T00:20:00.000Z",
        status: live.status,
        busy: live.busy,
      };
    },
  });
}

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})));
});

describe("WorkspaceBackupService", () => {
  test("filters by workingDirectory and includes active, closed, deleted, and failed backups", async () => {
    const { home, workspaceA, workspaceB } = await makeTmpWorkspaces();

    await fs.writeFile(path.join(workspaceA, "active.txt"), "one\n", "utf-8");
    const active = await SessionBackupManager.create({
      sessionId: "session-active",
      workingDirectory: workspaceA,
      homedir: home,
    });
    await fs.writeFile(path.join(workspaceA, "active.txt"), "two\n", "utf-8");
    const changedCheckpoint = await active.createCheckpoint("manual");
    const unchangedCheckpoint = await active.createCheckpoint("auto");
    expect(unchangedCheckpoint.changed).toBe(false);

    await fs.writeFile(path.join(workspaceA, "closed.txt"), "closed\n", "utf-8");
    const closed = await SessionBackupManager.create({
      sessionId: "session-closed",
      workingDirectory: workspaceA,
      homedir: home,
    });
    await closed.close();

    await fs.writeFile(path.join(workspaceA, "deleted.txt"), "deleted\n", "utf-8");
    const deleted = await SessionBackupManager.create({
      sessionId: "session-deleted",
      workingDirectory: workspaceA,
      homedir: home,
    });
    await deleted.close();

    await fs.writeFile(path.join(workspaceB, "other.txt"), "other\n", "utf-8");
    await SessionBackupManager.create({
      sessionId: "session-other",
      workingDirectory: workspaceB,
      homedir: home,
    });

    await fs.writeFile(path.join(workspaceA, "failed.txt"), "failed\n", "utf-8");
    const failed = await SessionBackupManager.create({
      sessionId: "session-failed",
      workingDirectory: workspaceA,
      homedir: home,
    });
    await failed.close();
    const failedState = failed.getPublicState();
    if (!failedState.backupDirectory) throw new Error("Expected failed backup directory");
    await fs.writeFile(
      path.join(failedState.backupDirectory, "metadata.json"),
      JSON.stringify({
        version: 1,
        sessionId: "session-failed",
        workingDirectory: workspaceA,
        createdAt: "2026-03-10T00:00:00.000Z",
        state: "closed",
        checkpoints: "bad",
      }),
      "utf-8",
    );

    const service = makeService({
      home,
      records: {
        "session-active": makeSessionRecord("session-active", "active"),
        "session-closed": makeSessionRecord("session-closed", "closed"),
      },
      live: {
        "session-active": { busy: false, status: "active" },
      },
    });

    const entries = await service.listWorkspaceBackups(workspaceA);
    expect(entries.map((entry) => entry.targetSessionId).sort()).toEqual([
      "session-active",
      "session-closed",
      "session-deleted",
      "session-failed",
    ]);

    const activeEntry = entries.find((entry) => entry.targetSessionId === "session-active");
    const closedEntry = entries.find((entry) => entry.targetSessionId === "session-closed");
    const deletedEntry = entries.find((entry) => entry.targetSessionId === "session-deleted");
    const failedEntry = entries.find((entry) => entry.targetSessionId === "session-failed");

    expect(activeEntry?.lifecycle).toBe("active");
    expect(closedEntry?.lifecycle).toBe("closed");
    expect(deletedEntry?.lifecycle).toBe("deleted");
    expect(failedEntry?.status).toBe("failed");
    expect(failedEntry?.failureReason).toContain("Invalid backup metadata schema");
    expect(activeEntry?.checkpointBytesTotal).toBe(changedCheckpoint.patchBytes);
    expect(activeEntry?.totalBytes).toBe(
      (activeEntry?.originalSnapshotBytes ?? 0) + (activeEntry?.checkpointBytesTotal ?? 0),
    );
  });

  test("blocks checkpoint, restore, and delete when the live session is busy", async () => {
    const { home, workspaceA } = await makeTmpWorkspaces();
    await fs.writeFile(path.join(workspaceA, "busy.txt"), "busy\n", "utf-8");

    const busy = await SessionBackupManager.create({
      sessionId: "session-busy",
      workingDirectory: workspaceA,
      homedir: home,
    });
    const checkpoint = await busy.createCheckpoint("manual");

    const service = makeService({
      home,
      records: {
        "session-busy": makeSessionRecord("session-busy", "active"),
      },
      live: {
        "session-busy": { busy: true, status: "active" },
      },
    });

    await expect(service.createCheckpoint(workspaceA, "session-busy")).rejects.toThrow("Session is busy");
    await expect(service.restoreBackup(workspaceA, "session-busy", checkpoint.id)).rejects.toThrow("Session is busy");
    await expect(service.deleteCheckpoint(workspaceA, "session-busy", checkpoint.id)).rejects.toThrow("Session is busy");
  });

  test("deleteEntry disables a live session override before removing its backup directory", async () => {
    const { home, workspaceA } = await makeTmpWorkspaces();
    await fs.writeFile(path.join(workspaceA, "live.txt"), "one\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: "session-live-delete",
      workingDirectory: workspaceA,
      homedir: home,
    });
    const backupDirectory = manager.getPublicState().backupDirectory;
    if (!backupDirectory) throw new Error("Expected backup directory");

    const overrideCalls: Array<boolean | null> = [];
    const service = new WorkspaceBackupService({
      homedir: home,
      sessionDb: {
        getSessionRecord: (sessionId: string) => (
          sessionId === "session-live-delete" ? makeSessionRecord("session-live-delete", "active") : null
        ),
      } as any,
      getLiveSession: (sessionId: string) => {
        if (sessionId !== "session-live-delete") return null;
        return {
          sessionId,
          title: "Live delete",
          provider: "openai",
          model: "gpt-5.2",
          updatedAt: "2026-03-10T00:20:00.000Z",
          status: "active" as const,
          busy: false,
          setBackupsEnabledOverride: async (enabled: boolean | null) => {
            overrideCalls.push(enabled);
          },
        };
      },
    });

    const entries = await service.deleteEntry(workspaceA, "session-live-delete");
    expect(overrideCalls).toEqual([false]);
    expect(entries.find((entry) => entry.targetSessionId === "session-live-delete")).toBeUndefined();
    await expect(fs.stat(backupDirectory)).rejects.toThrow();
  });

  test("restore creates a safety checkpoint before overwriting the workspace", async () => {
    const { home, workspaceA } = await makeTmpWorkspaces();
    const filePath = path.join(workspaceA, "restore.txt");
    await fs.writeFile(filePath, "one\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: "session-restore",
      workingDirectory: workspaceA,
      homedir: home,
    });
    await fs.writeFile(filePath, "two\n", "utf-8");
    const checkpoint = await manager.createCheckpoint("manual");
    await fs.writeFile(filePath, "three\n", "utf-8");

    const service = makeService({ home });
    const entries = await service.restoreBackup(workspaceA, "session-restore", checkpoint.id);
    const restoredEntry = entries.find((entry) => entry.targetSessionId === "session-restore");

    expect(await fs.readFile(filePath, "utf-8")).toBe("two\n");
    expect(restoredEntry?.checkpoints).toHaveLength(3);
    expect(restoredEntry?.checkpoints.at(-1)?.trigger).toBe("manual");
  });

  test("computes per-checkpoint file delta previews against the previous snapshot", async () => {
    const { home, workspaceA } = await makeTmpWorkspaces();
    const modifiedPath = path.join(workspaceA, "modified.txt");
    const deletedPath = path.join(workspaceA, "deleted.txt");
    const addedPath = path.join(workspaceA, "nested", "added.txt");

    await fs.writeFile(modifiedPath, "one\n", "utf-8");
    await fs.writeFile(deletedPath, "remove me\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: "session-delta",
      workingDirectory: workspaceA,
      homedir: home,
    });

    await fs.writeFile(modifiedPath, "two\n", "utf-8");
    await fs.rm(deletedPath);
    await fs.mkdir(path.dirname(addedPath), { recursive: true });
    await fs.writeFile(addedPath, "brand new\n", "utf-8");

    const checkpoint = await manager.createCheckpoint("manual");
    const service = makeService({ home });
    const delta = await service.getCheckpointDelta(workspaceA, "session-delta", checkpoint.id);

    expect(delta.baselineLabel).toBe("cp-0001");
    expect(delta.currentLabel).toBe(checkpoint.id);
    expect(delta.counts).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(delta.files.map((file) => `${file.change}:${file.path}`)).toEqual([
      "deleted:deleted.txt",
      "modified:modified.txt",
      "added:nested/added.txt",
    ]);
  });

  test("older metadata is backfilled with originalFingerprint before checkpointing", async () => {
    const { home, workspaceA } = await makeTmpWorkspaces();
    const filePath = path.join(workspaceA, "legacy.txt");
    await fs.writeFile(filePath, "one\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: "session-legacy",
      workingDirectory: workspaceA,
      homedir: home,
    });
    const state = manager.getPublicState();
    if (!state.backupDirectory) throw new Error("Expected backup directory");

    const metadataPath = path.join(state.backupDirectory, "metadata.json");
    const metadata = await readMetadata(metadataPath);
    if (!metadata) throw new Error("Expected metadata");
    delete metadata.originalFingerprint;
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    await fs.writeFile(filePath, "two\n", "utf-8");
    const service = makeService({ home });
    const entries = await service.createCheckpoint(workspaceA, "session-legacy");
    const updatedMetadata = await readMetadata(metadataPath);
    const entry = entries.find((item) => item.targetSessionId === "session-legacy");

    expect(updatedMetadata?.originalFingerprint).toBeTruthy();
    expect(entry?.checkpoints).toHaveLength(2);
  });

  test("cannot delete the initial checkpoint", async () => {
    const { home, workspaceA } = await makeTmpWorkspaces();
    await fs.writeFile(path.join(workspaceA, "initial.txt"), "one\n", "utf-8");

    const manager = await SessionBackupManager.create({
      sessionId: "session-initial",
      workingDirectory: workspaceA,
      homedir: home,
    });

    const state = manager.getPublicState();
    const initialCheckpoint = state.checkpoints[0];
    expect(initialCheckpoint?.trigger).toBe("initial");

    await expect(manager.deleteCheckpoint(initialCheckpoint!.id)).rejects.toThrow("Cannot delete the initial checkpoint");

    const afterDelete = manager.getPublicState();
    expect(afterDelete.checkpoints).toHaveLength(1);
    expect(afterDelete.checkpoints[0]?.id).toBe(initialCheckpoint!.id);
  });
});
