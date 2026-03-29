import { describe, expect, mock, test } from "bun:test";

import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";

mock.module("electron", () => ({
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
}));

const { registerWorkspaceIpc } = await import("../electron/ipc/workspace");

describe("workspace IPC", () => {
  test("updates approved roots before invalidating workspace cache", async () => {
    const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown> | unknown>();
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

    await saveStateHandler?.({}, {
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
    });

    expect(callOrder).toEqual([
      "saveState",
      "setApprovedWorkspaceRoots",
      "invalidateWorkspaceListCache",
    ]);
    expect(approvedRoots).toEqual(["/tmp/ws-1"]);
  });
});
