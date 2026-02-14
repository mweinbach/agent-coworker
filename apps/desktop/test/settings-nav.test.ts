import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {},
  startWorkspaceServer: async () => ({ url: "ws://mock" }),
  stopWorkspaceServer: async () => {},
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
    useAppStore.getState().openSettings("sessions");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("sessions");
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

  test("cancelThread clears busy state when socket is unavailable", () => {
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
          backup: null,
          backupReason: null,
          backupUi: {
            refreshing: false,
            checkpointing: false,
            restoring: false,
            deletingById: {},
            error: null,
          },
          transcriptOnly: false,
        },
      },
      notifications: [],
    });

    useAppStore.getState().cancelThread("t1");
    const state = useAppStore.getState();
    expect(state.threadRuntimeById.t1?.busy).toBe(false);
    expect(state.threadRuntimeById.t1?.connected).toBe(false);
    expect(state.threads[0]?.status).toBe("disconnected");
    expect(state.notifications.at(-1)?.title).toBe("Not connected");
  });

  test("reconnectThread clears busy and keeps active thread selected", async () => {
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
      selectedWorkspaceId: "ws-1",
      selectedThreadId: "t1",
      threadRuntimeById: {
        t1: {
          wsUrl: "ws://mock",
          connected: true,
          sessionId: "sid-1",
          config: null,
          enableMcp: null,
          busy: true,
          busySince: "2024-01-01T00:00:00.000Z",
          feed: [],
          backup: null,
          backupReason: null,
          backupUi: {
            refreshing: false,
            checkpointing: false,
            restoring: false,
            deletingById: {},
            error: null,
          },
          transcriptOnly: false,
        },
      },
      notifications: [],
    });

    await useAppStore.getState().reconnectThread("t1");
    const state = useAppStore.getState();
    expect(state.selectedThreadId).toBe("t1");
    expect(state.threadRuntimeById.t1?.busy).toBe(false);
    expect(state.threadRuntimeById.t1?.busySince).toBeNull();
    expect(state.threads[0]?.status).toBe("active");
    expect(state.notifications.at(-1)?.title).toBe("Reconnecting thread");
  });
});
