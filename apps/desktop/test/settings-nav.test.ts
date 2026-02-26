import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {},
  startWorkspaceServer: async () => ({ url: "ws://mock" }),
  stopWorkspaceServer: async () => {},
  showContextMenu: async () => null,
  windowMinimize: async () => {},
  windowMaximize: async () => {},
  windowClose: async () => {},
  getPlatform: async () => "linux",
  readFile: async () => "",
  previewOSFile: async () => {},
  openPath: async () => {},
  revealPath: async () => {},
  copyPath: async () => {},
  createDirectory: async () => {},
  renamePath: async () => {},
  trashPath: async () => {},
  confirmAction: async () => true,
  showNotification: async () => true,
  getSystemAppearance: async () => "light",
  setWindowAppearance: async () => "light",
  onSystemAppearanceChanged: () => () => {},
  onMenuCommand: () => () => {},
}));

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: class {
    connect() {}
    send() {
      return true;
    }
    close() {}
  },
}));

const { useAppStore } = await import("../src/app/store");

describe("settings nav (store)", () => {
  beforeEach(() => {
    useAppStore.setState({
      view: "chat",
      lastNonSettingsView: "chat",
      settingsPage: "providers",
      notifications: [],
      workspaces: [],
      selectedWorkspaceId: null,
    });
  });

  test("openSettings records lastNonSettingsView and enters settings", () => {
    useAppStore.setState({ view: "skills" });
    useAppStore.getState().openSettings();
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().lastNonSettingsView).toBe("skills");
  });

  test("openSettings optionally selects a settings page", () => {
    useAppStore.getState().openSettings("workspaces");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("workspaces");
  });

  test("closeSettings restores the prior view", () => {
    useAppStore.setState({ view: "skills" });
    useAppStore.getState().openSettings();
    useAppStore.getState().closeSettings();
    expect(useAppStore.getState().view).toBe("skills");
  });

  test("setSettingsPage updates settingsPage", () => {
    useAppStore.getState().setSettingsPage("workspaces");
    expect(useAppStore.getState().settingsPage).toBe("workspaces");
  });

  test("setSettingsPage accepts mcp page", () => {
    useAppStore.getState().setSettingsPage("mcp");
    expect(useAppStore.getState().settingsPage).toBe("mcp");
  });

  test("setDeveloperMode updates developer mode state", () => {
    useAppStore.getState().setDeveloperMode(true);
    expect(useAppStore.getState().developerMode).toBe(true);
  });

  test("openSkills shows guidance when no workspace is available", async () => {
    await useAppStore.getState().openSkills();
    expect(useAppStore.getState().view).toBe("chat");
    const last = useAppStore.getState().notifications.at(-1);
    expect(last?.title).toBe("Skills need a workspace");
  });

  test("newThread falls back to first workspace when none is selected", async () => {
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/ws-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastOpenedAt: "2024-01-01T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: null,
      threads: [],
    });

    await useAppStore.getState().newThread();
    const state = useAppStore.getState();

    expect(state.selectedWorkspaceId).toBe("ws-1");
    expect(state.threads.length).toBe(1);
    expect(state.threads[0]?.workspaceId).toBe("ws-1");
    expect(state.selectedThreadId).toBe(state.threads[0]?.id);
  });

  test("cancelThread does not auto-reset busy state when socket is unavailable", () => {
    useAppStore.setState({
      threads: [
        {
          id: "t1",
          workspaceId: "ws-1",
          title: "Thread",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastMessageAt: "2024-01-01T00:00:00.000Z",
          status: "active",
        },
      ],
      threadRuntimeById: {
        t1: {
          wsUrl: "ws://mock",
          connected: true,
          sessionId: null,
          config: null,
          enableMcp: null,
          busy: true,
          busySince: "2024-01-01T00:00:00.000Z",
          feed: [],
          transcriptOnly: false,
        },
      },
      notifications: [],
    });

    useAppStore.getState().cancelThread("t1");
    const state = useAppStore.getState();
    expect(state.threadRuntimeById.t1?.busy).toBe(true);
    expect(state.threadRuntimeById.t1?.connected).toBe(true);
    expect(state.threads[0]?.status).toBe("active");
    expect(state.notifications.at(-1)?.title).toBe("Not connected");
  });
});
