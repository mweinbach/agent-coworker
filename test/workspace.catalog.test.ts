import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireWorkspacePath } from "../src/server/jsonrpc/routes/shared";
import { listWorkspaceSummaries } from "../src/server/jsonrpc/workspaceCatalog";
import { WebDesktopService, type WebDesktopServiceLike } from "../src/server/webDesktopService";
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

  test("requireWorkspacePath confines task RPCs to the canonical active workspace", async () => {
    const homedir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-home-"));
    try {
      const projectRoot = path.join(homedir, "project");
      const outsideRoot = path.join(homedir, "outside");
      const aliasDir = path.join(homedir, "project-alias");
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.mkdir(outsideRoot, { recursive: true });
      const projectDir = await fs.realpath(projectRoot);
      const outsideDir = await fs.realpath(outsideRoot);
      await fs.symlink(projectDir, aliasDir, "dir");

      expect(requireWorkspacePath({}, "task/list", projectDir, homedir)).toBe(
        await fs.realpath(projectDir),
      );
      expect(requireWorkspacePath({ cwd: projectDir }, "task/list", projectDir, homedir)).toBe(
        await fs.realpath(projectDir),
      );
      expect(() =>
        requireWorkspacePath({ cwd: outsideDir }, "task/list", projectDir, homedir),
      ).toThrow("task/list cwd must match an authorized workspace");
      expect(() =>
        requireWorkspacePath({ cwd: aliasDir }, "task/list", projectDir, homedir),
      ).toThrow("task/list cwd must use the canonical workspace path");
      expect(() =>
        requireWorkspacePath({ cwd: "C:project" }, "task/list", projectDir, homedir),
      ).toThrow("task/list cwd must use an absolute workspace path");
    } finally {
      await fs.rm(homedir, { recursive: true, force: true });
    }
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

  test("listWorkspaceSummaries preserves promoted projects under ~/.cowork/chats", async () => {
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
        workspaceKind: "project",
      }),
    ]);
  });

  test("listWorkspaceSummaries classifies legacy missing-kind chat records with configured home", async () => {
    const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-catalog-home-"));
    const realHomeRoot = path.join(cleanupRoot, "home-real");
    const aliasHome = path.join(cleanupRoot, "home-alias");
    const userDataDir = path.join(cleanupRoot, "user-data");
    const legacyChat = path.join(aliasHome, ".cowork", "chats", "legacy-chat");
    const promotedProject = path.join(aliasHome, ".cowork", "chats", "promoted-project");
    const ordinaryProject = path.join(cleanupRoot, "ordinary-project");
    try {
      await fs.mkdir(realHomeRoot, { recursive: true });
      await fs.symlink(realHomeRoot, aliasHome, process.platform === "win32" ? "junction" : "dir");
      await fs.mkdir(legacyChat, { recursive: true });
      await fs.mkdir(promotedProject, { recursive: true });
      await fs.mkdir(ordinaryProject, { recursive: true });
      await fs.mkdir(userDataDir, { recursive: true });
      const timestamp = "2026-06-20T00:00:00.000Z";
      await fs.writeFile(
        path.join(userDataDir, "state.json"),
        JSON.stringify({
          version: 2,
          workspaces: [
            {
              id: "legacy-chat",
              name: "Legacy chat",
              path: legacyChat,
              createdAt: timestamp,
              lastOpenedAt: timestamp,
            },
            {
              id: "promoted-project",
              name: "Promoted project",
              path: promotedProject,
              workspaceKind: "project",
              createdAt: timestamp,
              lastOpenedAt: timestamp,
            },
            {
              id: "ordinary-project",
              name: "Ordinary project",
              path: ordinaryProject,
              createdAt: timestamp,
              lastOpenedAt: timestamp,
            },
          ],
          threads: [],
        }),
      );

      const desktopService = new WebDesktopService({ userDataDir, homedir: aliasHome });
      const result = await listWorkspaceSummaries({
        workingDirectory: await fs.realpath(legacyChat),
        desktopService,
        homedir: aliasHome,
      });

      expect(result.workspaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "legacy-chat",
            path: await fs.realpath(legacyChat),
            workspaceKind: "oneOffChat",
          }),
          expect.objectContaining({
            id: "promoted-project",
            path: await fs.realpath(promotedProject),
            workspaceKind: "project",
          }),
          expect.objectContaining({
            id: "ordinary-project",
            path: await fs.realpath(ordinaryProject),
            workspaceKind: "project",
          }),
        ]),
      );
    } finally {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
    }
  });
});
