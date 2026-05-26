import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { requireWorkspacePath } from "../src/server/jsonrpc/routes/shared";
import { listWorkspaceSummaries } from "../src/server/jsonrpc/workspaceCatalog";
import type { WebDesktopServiceLike } from "../src/server/webDesktopService";
import { getOneOffChatsRoot } from "../src/utils/oneOffChats";

describe("workspace catalog and path rules", () => {
  test("requireWorkspacePath accepts one-off chat directories under ~/.cowork/chats", async () => {
    const homedir = await fs.mkdtemp(path.join(process.cwd(), "cowork-home-"));
    const projectDir = path.join(homedir, "project");
    const chatDir = path.join(getOneOffChatsRoot(homedir), "20260516-chat-a");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(chatDir, { recursive: true });

    const resolved = requireWorkspacePath({ cwd: chatDir }, "thread/list", projectDir, homedir);
    expect(resolved).toBe(await fs.realpath(chatDir));
    await fs.rm(homedir, { recursive: true, force: true });
  });

  test("requireWorkspacePath rejects project-local .cowork/chats paths", async () => {
    const homedir = await fs.mkdtemp(path.join(process.cwd(), "cowork-home-"));
    const projectDir = path.join(homedir, "project");
    const legacyChatDir = path.join(projectDir, ".cowork", "chats", "legacy-chat");
    await fs.mkdir(legacyChatDir, { recursive: true });

    expect(() =>
      requireWorkspacePath({ cwd: legacyChatDir }, "thread/list", projectDir, homedir),
    ).toThrow("thread/list cwd must match the server workspace or a one-off chat workspace");
    await fs.rm(homedir, { recursive: true, force: true });
  });

  test("listWorkspaceSummaries returns desktop workspaces with workspaceKind", async () => {
    const projectPath = "/tmp/project-a";
    const chatPath = "/tmp/chats/chat-1";
    const desktopService: WebDesktopServiceLike = {
      loadState: async () => ({
        version: 2,
        workspaces: [
          {
            id: "project-1",
            name: "Project A",
            path: projectPath,
            workspaceKind: "project",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-02T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
          {
            id: "chat-1",
            name: "Chat One",
            path: chatPath,
            workspaceKind: "oneOffChat",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-03T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        threads: [],
        developerMode: false,
        showHiddenFiles: false,
        perWorkspaceSettings: false,
        desktopSettings: {
          quickChat: {
            shortcutEnabled: false,
            shortcutAccelerator: "CommandOrControl+Shift+C",
          },
        },
        desktopFeatureFlagOverrides: {},
      }),
      saveState: async (state) => state as any,
      listWorkspaces: async () => [],
      createOneOffChatWorkspace: async () => ({ name: "New chat", path: chatPath }),
      getWorkspaceRoots: async () => [projectPath],
      resolveWorkspaceDirectory: async (workspacePath) => workspacePath,
      startWorkspaceServer: async () => ({ url: "ws://127.0.0.1:7337/ws" }),
      stopWorkspaceServer: async () => {},
      readTranscript: async () => [],
      appendTranscriptEvent: async () => {},
      appendTranscriptBatch: async () => {},
      deleteTranscript: async () => {},
      stopAll: async () => {},
    };

    const result = await listWorkspaceSummaries({
      workingDirectory: projectPath,
      desktopService,
    });

    expect(result.activeWorkspaceId).toBe("project-1");
    expect(result.workspaces).toEqual([
      expect.objectContaining({
        id: "project-1",
        workspaceKind: "project",
      }),
      expect.objectContaining({
        id: "chat-1",
        workspaceKind: "oneOffChat",
      }),
    ]);
  });

  test("listWorkspaceSummaries infers one-off chat workspaces from ~/.cowork/chats paths", async () => {
    const projectPath = "/tmp/project-a";
    const chatPath = path.join(getOneOffChatsRoot(), "20260524-new-chat");
    const desktopService: WebDesktopServiceLike = {
      loadState: async () => ({
        version: 2,
        workspaces: [
          {
            id: "chat-legacy",
            name: "New chat",
            path: chatPath,
            workspaceKind: "project",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-03T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        threads: [],
        developerMode: false,
        showHiddenFiles: false,
        perWorkspaceSettings: false,
        desktopSettings: {
          quickChat: {
            shortcutEnabled: false,
            shortcutAccelerator: "CommandOrControl+Shift+C",
          },
        },
        desktopFeatureFlagOverrides: {},
      }),
      saveState: async (state) => state as any,
      listWorkspaces: async () => [],
      createOneOffChatWorkspace: async () => ({ name: "New chat", path: chatPath }),
      getWorkspaceRoots: async () => [projectPath],
      resolveWorkspaceDirectory: async (workspacePath) => workspacePath,
      startWorkspaceServer: async () => ({ url: "ws://127.0.0.1:7337/ws" }),
      stopWorkspaceServer: async () => {},
      readTranscript: async () => [],
      appendTranscriptEvent: async () => {},
      appendTranscriptBatch: async () => {},
      deleteTranscript: async () => {},
      stopAll: async () => {},
    };

    const result = await listWorkspaceSummaries({
      workingDirectory: projectPath,
      desktopService,
    });

    expect(result.workspaces).toEqual([
      expect.objectContaining({
        id: "chat-legacy",
        workspaceKind: "oneOffChat",
      }),
    ]);
  });
});
