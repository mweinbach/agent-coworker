import { beforeEach, describe, expect, mock, test } from "bun:test";

import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

const electronMockOverrides = {
  BrowserWindow: {
    fromWebContents() {
      return null;
    },
    getFocusedWindow() {
      return null;
    },
  },
  dialog: {
    async showOpenDialog() {
      return { canceled: true, filePaths: [] };
    },
  },
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { registerWorkspaceIpc } = await import("../electron/ipc/workspace");

describe("workspace IPC", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  test("updates approved roots before invalidating workspace cache", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    const callOrder: string[] = [];
    let approvedRoots: string[] = [];

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: {
          invalidateWorkspaceListCache() {
            callOrder.push("invalidateWorkspaceListCache");
          },
        },
        persistence: {
          async saveState() {
            callOrder.push("saveState");
          },
          async loadState() {
            return { workspaces: [] };
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots(paths: Iterable<string>) {
          approvedRoots = [...paths];
          callOrder.push("setApprovedWorkspaceRoots");
        },
        getApprovedWorkspaceRoots() {
          return approvedRoots;
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const saveStateHandler = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    expect(saveStateHandler).toBeDefined();

    await saveStateHandler?.(
      {},
      {
        activeWorkspaceId: null,
        activeThreadId: null,
        workspaces: [
          {
            id: "ws-1",
            title: "Workspace One",
            path: "/tmp/ws-1",
            threadIds: [],
          },
        ],
        threadIndex: {},
        expandedSkillSectionByWorkspaceId: {},
        providersByWorkspaceId: {},
        providerSettingsByWorkspaceId: {},
        workspaceMcpConfigByWorkspaceId: {},
        inputByThreadId: {},
        modeByThreadId: {},
        profileByThreadId: {},
      },
    );

    expect(callOrder).toEqual([
      "saveState",
      "setApprovedWorkspaceRoots",
      "invalidateWorkspaceListCache",
    ]);
    expect(approvedRoots).toEqual(["/tmp/ws-1"]);
  });

  test("popup saveState preserves newer persisted data and merges popup threads", async () => {
    const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown> | unknown>();
    let savedState: any = null;

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: {
          invalidateWorkspaceListCache() {},
        },
        persistence: {
          async saveState(state: unknown) {
            savedState = state;
          },
          async loadState() {
            return {
              version: 2,
              workspaces: [
                {
                  id: "ws-main",
                  name: "Main workspace",
                  path: "/tmp/ws-main",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  lastOpenedAt: "2026-04-21T10:00:00.000Z",
                  defaultEnableMcp: true,
                  defaultBackupsEnabled: true,
                  yolo: false,
                },
                {
                  id: "ws-newer",
                  name: "Newer workspace",
                  path: "/tmp/ws-newer",
                  createdAt: "2026-04-21T09:00:00.000Z",
                  lastOpenedAt: "2026-04-21T11:00:00.000Z",
                  defaultEnableMcp: true,
                  defaultBackupsEnabled: true,
                  yolo: false,
                },
              ],
              threads: [
                {
                  id: "thread-main",
                  workspaceId: "ws-main",
                  title: "Latest main thread",
                  titleSource: "manual",
                  createdAt: "2026-04-21T09:00:00.000Z",
                  lastMessageAt: "2026-04-21T11:00:00.000Z",
                  status: "active",
                  sessionId: "session-main",
                  messageCount: 4,
                  lastEventSeq: 4,
                },
                {
                  id: "thread-newer",
                  workspaceId: "ws-newer",
                  title: "Newer thread",
                  titleSource: "manual",
                  createdAt: "2026-04-21T10:30:00.000Z",
                  lastMessageAt: "2026-04-21T11:30:00.000Z",
                  status: "active",
                  sessionId: "session-newer",
                  messageCount: 2,
                  lastEventSeq: 2,
                },
              ],
              developerMode: true,
              showHiddenFiles: true,
            };
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const saveStateHandler = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    expect(saveStateHandler).toBeDefined();

    await saveStateHandler?.(
      {
        sender: {
          getURL: () => "file:///renderer/index.html?window=quick-chat",
        },
      },
      {
        version: 2,
        workspaces: [
          {
            id: "ws-main",
            name: "Stale popup workspace",
            path: "/tmp/ws-main",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-04-21T08:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: true,
            yolo: false,
          },
        ],
        threads: [
          {
            id: "thread-main",
            workspaceId: "ws-main",
            title: "Stale popup thread",
            titleSource: "manual",
            createdAt: "2026-04-21T09:00:00.000Z",
            lastMessageAt: "2026-04-21T10:00:00.000Z",
            status: "active",
            sessionId: "session-main",
            messageCount: 3,
            lastEventSeq: 3,
          },
          {
            id: "thread-popup",
            workspaceId: "ws-main",
            title: "Popup draft",
            titleSource: "manual",
            createdAt: "2026-04-21T11:45:00.000Z",
            lastMessageAt: "2026-04-21T11:45:00.000Z",
            status: "active",
            sessionId: "session-popup",
            messageCount: 0,
            lastEventSeq: 0,
          },
        ],
        developerMode: false,
        showHiddenFiles: false,
      }
    );

    expect(savedState.workspaces.map((workspace: any) => workspace.id)).toEqual(["ws-main", "ws-newer"]);
    expect(savedState.threads.map((thread: any) => thread.id)).toEqual(["thread-main", "thread-newer", "thread-popup"]);
    expect(savedState.threads[0]?.title).toBe("Latest main thread");
    expect(savedState.developerMode).toBe(true);
    expect(savedState.showHiddenFiles).toBe(true);
  });
});
