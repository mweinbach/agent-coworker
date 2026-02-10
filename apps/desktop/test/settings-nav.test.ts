import { beforeEach, describe, expect, mock, test } from "bun:test";

// Store imports Tauri modules; mock them before importing the store.
mock.module("@tauri-apps/plugin-dialog", () => ({
  open: async () => null,
}));

mock.module("../src/lib/tauriCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
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
});

