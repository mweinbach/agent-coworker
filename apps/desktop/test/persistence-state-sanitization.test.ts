import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let userDataDir = "";

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const { PersistenceService } = await import("../electron/services/persistence");

const TS = "2024-01-01T00:00:00.000Z";

describe("desktop persistence state sanitization", () => {
  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-state-"));
  });

  afterEach(async () => {
    if (!userDataDir) {
      return;
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
    userDataDir = "";
  });

  test("drops workspaces with invalid paths and orphaned threads", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-valid");
    const missingWorkspace = path.join(userDataDir, "workspace-missing");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 1,
      workspaces: [
        {
          id: "ws_valid",
          name: "Valid workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          yolo: false,
        },
        {
          id: "ws_missing",
          name: "Missing workspace",
          path: missingWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: false,
          yolo: true,
        },
      ],
      threads: [
        {
          id: "thread_valid",
          workspaceId: "ws_valid",
          title: "Valid thread",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
        },
        {
          id: "thread_orphan",
          workspaceId: "ws_missing",
          title: "Orphan thread",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
        },
      ],
      developerMode: true,
    });

    const state = await persistence.loadState();
    expect(state.workspaces.length).toBe(1);
    expect(state.workspaces[0]?.id).toBe("ws_valid");
    expect(state.workspaces[0]?.path).toBe(await fs.realpath(validWorkspace));
    expect(state.threads.map((thread) => thread.id)).toEqual(["thread_valid"]);
  });

  test("normalizes malformed on-disk state payloads", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-from-disk");
    await fs.mkdir(validWorkspace, { recursive: true });

    const statePath = path.join(userDataDir, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: "bad",
          workspaces: [
            {
              id: "ws_disk",
              name: "Disk workspace",
              path: validWorkspace,
              createdAt: TS,
              lastOpenedAt: TS,
              defaultEnableMcp: "yes",
              yolo: "no",
            },
          ],
          threads: [
            {
              id: "thread_disk",
              workspaceId: "ws_disk",
              title: "Thread",
              createdAt: TS,
              lastMessageAt: TS,
              status: "unknown",
            },
          ],
          developerMode: "sometimes",
        },
        null,
        2
      ),
      "utf8"
    );

    const state = await persistence.loadState();
    expect(state.version).toBe(1);
    expect(state.developerMode).toBe(false);
    expect(state.workspaces[0]?.defaultEnableMcp).toBe(true);
    expect(state.workspaces[0]?.yolo).toBe(false);
    expect(state.threads[0]?.status).toBe("disconnected");
  });
});
