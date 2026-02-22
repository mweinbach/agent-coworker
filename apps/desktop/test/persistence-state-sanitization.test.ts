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

describe("desktop persistence state validation", () => {
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

  test("rejects states with invalid workspace paths", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-valid");
    const missingWorkspace = path.join(userDataDir, "workspace-missing");
    await fs.mkdir(validWorkspace, { recursive: true });

    await expect(
      persistence.saveState({
        version: 2,
        workspaces: [
          {
            id: "ws_valid",
            name: "Valid workspace",
            path: validWorkspace,
            createdAt: TS,
            lastOpenedAt: TS,
            defaultSubAgentModel: "gpt-5.2-mini",
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
            titleSource: "manual",
            createdAt: TS,
            lastMessageAt: TS,
            status: "active",
            sessionId: null,
            lastEventSeq: 0,
          },
          {
            id: "thread_orphan",
            workspaceId: "ws_missing",
            title: "Orphan thread",
            titleSource: "manual",
            createdAt: TS,
            lastMessageAt: TS,
            status: "active",
            sessionId: null,
            lastEventSeq: 0,
          },
        ],
        developerMode: true,
        showHiddenFiles: true,
      }),
    ).rejects.toThrow("Workspace path is missing or invalid");
  });

  test("rejects malformed on-disk state payloads", async () => {
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
              defaultSubAgentModel: 123,
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
          showHiddenFiles: "always",
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(persistence.loadState()).rejects.toThrow("Failed to load state");
  });
});
