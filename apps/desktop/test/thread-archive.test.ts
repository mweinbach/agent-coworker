import { beforeEach, describe, expect, mock, test } from "bun:test";

import { selectSidebarThreadsForWorkspace } from "../src/ui/sidebarSelectors";
import { selectArchivedThreadsSorted } from "../src/ui/settings/sessionSelectors";

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

describe("thread archiving (store)", () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [
        {
          id: "w1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastOpenedAt: "2024-01-01T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "t1",
          workspaceId: "w1",
          title: "First",
          createdAt: "2024-01-01T01:00:00.000Z",
          lastMessageAt: "2024-01-03T01:00:00.000Z",
          status: "active",
        },
        {
          id: "t2",
          workspaceId: "w1",
          title: "Second",
          createdAt: "2024-01-02T01:00:00.000Z",
          lastMessageAt: "2024-01-02T01:00:00.000Z",
          status: "disconnected",
        },
      ],
      selectedWorkspaceId: "w1",
      selectedThreadId: null,
    });
  });

  test("archiveThread marks status archived and hides from sidebar selector", async () => {
    await useAppStore.getState().archiveThread("t1");
    const archived = useAppStore.getState().threads.find((t) => t.id === "t1");
    expect(archived?.status).toBe("archived");

    const sidebar = selectSidebarThreadsForWorkspace(useAppStore.getState().threads, "w1").map((t) => t.id);
    expect(sidebar).toEqual(["t2"]);
  });

  test("unarchiveThread restores to disconnected", async () => {
    await useAppStore.getState().archiveThread("t1");
    await useAppStore.getState().unarchiveThread("t1");
    const t = useAppStore.getState().threads.find((x) => x.id === "t1");
    expect(t?.status).toBe("disconnected");
  });

  test("archived sessions selector sorts by lastMessageAt desc", () => {
    const threads = [
      {
        id: "a",
        workspaceId: "w1",
        title: "A",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastMessageAt: "2024-01-02T00:00:00.000Z",
        status: "archived" as const,
      },
      {
        id: "b",
        workspaceId: "w1",
        title: "B",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastMessageAt: "2024-01-03T00:00:00.000Z",
        status: "archived" as const,
      },
    ];

    expect(selectArchivedThreadsSorted(threads).map((t) => t.id)).toEqual(["b", "a"]);
  });
});

