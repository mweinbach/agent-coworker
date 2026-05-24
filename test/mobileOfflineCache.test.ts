import { beforeEach, describe, expect, mock, test } from "bun:test";

import path from "node:path";

import {
  clearAllOfflineWorkspaceCache,
  loadAllOfflineWorkspaceCache,
  loadFromOfflineCache,
  saveToOfflineCache,
} from "../apps/mobile/src/features/cowork/offlineCache";
import { useProviderStore } from "../apps/mobile/src/features/cowork/providerStore";
import {
  loadThreadOfflineCache,
  saveThreadOfflineCache,
} from "../apps/mobile/src/features/cowork/threadOfflineCache";
import { useThreadStore } from "../apps/mobile/src/features/cowork/threadStore";
import { useWorkspaceStore } from "../apps/mobile/src/features/cowork/workspaceStore";

describe("mobile offline cache", () => {
  beforeEach(async () => {
    await clearAllOfflineWorkspaceCache();
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      activeWorkspaceName: null,
      activeWorkspaceCwd: null,
      controlSnapshot: null,
      loading: false,
      error: null,
    });
    useProviderStore.setState({
      catalog: [],
      authMethodsByProvider: {},
      statusByProvider: {},
    });
    useThreadStore.setState({
      snapshots: {},
      threads: [],
      selectedThreadId: null,
      pendingRequests: {},
      activeTurnStartedAt: {},
      expandedWorkspaceIds: {},
    });
  });

  test("saves and loads items from cache", async () => {
    await saveToOfflineCache("test-key", { hello: "world" });
    const loaded = await loadFromOfflineCache<any>("test-key");
    expect(loaded).toEqual({ hello: "world" });
  });

  test("loads all offline workspace cache into Zustand stores", async () => {
    // Seed some data into the mock secure store
    await saveToOfflineCache("workspaces", [{ id: "w1", name: "Workspace 1", path: "/path/1" }]);
    await saveToOfflineCache("activeWorkspaceId", "w1");
    await saveToOfflineCache("activeWorkspaceCwd", "/path/1");
    await saveToOfflineCache("providerCatalog", [{ id: "p1", name: "Provider 1" }]);

    // Run hydration
    await loadAllOfflineWorkspaceCache();

    // Verify Zustand state
    expect(useWorkspaceStore.getState().workspaces).toEqual([
      { id: "w1", name: "Workspace 1", path: "/path/1" } as any,
    ]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("w1");
    expect(useWorkspaceStore.getState().activeWorkspaceCwd).toBe("/path/1");
    expect(useProviderStore.getState().catalog).toEqual([{ id: "p1", name: "Provider 1" } as any]);
  });

  test("clears all offline workspace cache", async () => {
    await saveToOfflineCache("workspaces", [{ id: "w1" }]);
    await saveThreadOfflineCache({
      threads: [
        {
          id: "thread-1",
          title: "Thread",
          preview: "Cached",
          updatedAt: "2026-01-01T00:00:00.000Z",
          cwd: "/path/1",
          workspaceId: "w1",
          workspaceName: "Workspace 1",
          workspaceKind: "project",
          feed: [],
          composerDraft: "",
          pendingPrompt: false,
          pendingServerRequest: null,
        },
      ],
      snapshots: {
        "thread-1": {
          sessionId: "thread-1",
          title: "Thread",
          titleSource: "manual",
          provider: "opencode",
          model: "remote-session",
          sessionKind: "primary",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          lastEventSeq: 1,
          feed: [],
          agents: [],
          todos: [],
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      },
      expandedWorkspaceIds: {},
    });
    await clearAllOfflineWorkspaceCache();
    const loaded = await loadFromOfflineCache("workspaces");
    expect(loaded).toBeNull();
    expect(await loadThreadOfflineCache()).toBeNull();
  });

  test("saves and hydrates cached thread snapshots", async () => {
    await saveThreadOfflineCache({
      threads: [
        {
          id: "thread-cache-1",
          title: "Cached Thread",
          preview: "Last cached reply",
          updatedAt: "2026-01-01T00:00:00.000Z",
          cwd: "/path/1",
          workspaceId: "w1",
          workspaceName: "Workspace 1",
          workspaceKind: "project",
          feed: [
            {
              id: "msg-1",
              kind: "message",
              role: "assistant",
              ts: "2026-01-01T00:00:00.000Z",
              text: "Last cached reply",
            },
          ],
          composerDraft: "do not persist drafts",
          pendingPrompt: true,
          pendingServerRequest: {
            kind: "ask",
            requestId: "req-1",
            threadId: "thread-cache-1",
            itemId: "item-1",
            question: "Continue?",
            options: [],
          },
        },
      ],
      snapshots: {
        "thread-cache-1": {
          sessionId: "thread-cache-1",
          title: "Cached Thread",
          titleSource: "manual",
          provider: "opencode",
          model: "remote-session",
          sessionKind: "primary",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          lastEventSeq: 4,
          feed: [
            {
              id: "msg-1",
              kind: "message",
              role: "assistant",
              ts: "2026-01-01T00:00:00.000Z",
              text: "Last cached reply",
            },
          ],
          agents: [],
          todos: [],
          hasPendingAsk: true,
          hasPendingApproval: true,
        },
      },
      expandedWorkspaceIds: { w1: true },
    });

    const cached = await loadThreadOfflineCache();
    expect(cached?.threads[0]).toMatchObject({
      id: "thread-cache-1",
      composerDraft: "",
      pendingPrompt: false,
      pendingServerRequest: null,
    });
    expect(cached?.snapshots["thread-cache-1"]?.hasPendingAsk).toBe(false);

    useThreadStore.getState().hydrateOfflineCache(cached!);
    expect(useThreadStore.getState().threads[0]?.title).toBe("Cached Thread");
    expect(useThreadStore.getState().threads[0]?.feed[0]?.id).toBe("msg-1");
    expect(useThreadStore.getState().expandedWorkspaceIds.w1).toBe(true);
  });
});
