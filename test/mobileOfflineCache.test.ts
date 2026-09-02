import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createRequire } from "node:module";

import path from "node:path";

import {
  clearAllOfflineWorkspaceCache,
  loadAllOfflineWorkspaceCache,
  loadFromOfflineCache,
  saveToOfflineCache,
} from "../apps/mobile/src/features/cowork/offlineCache";
import {
  claimOfflineDraftRecovery,
  clearLegacyOfflineCache,
} from "../apps/mobile/src/features/cowork/offlineCacheStorage";
import { useProviderStore } from "../apps/mobile/src/features/cowork/providerStore";
import { defaultThreadHomeUiState } from "../apps/mobile/src/features/cowork/threadHomeModel";
import {
  loadThreadOfflineCache,
  saveThreadOfflineCache,
  type ThreadOfflineCache,
} from "../apps/mobile/src/features/cowork/threadOfflineCache";
import {
  flushThreadOfflineCache,
  useThreadStore,
} from "../apps/mobile/src/features/cowork/threadStore";
import { useWorkspaceStore } from "../apps/mobile/src/features/cowork/workspaceStore";

const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));
const secureStore = mobileRequire("expo-secure-store") as typeof import("expo-secure-store");

describe("mobile offline cache", () => {
  beforeEach(async () => {
    await flushThreadOfflineCache();
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
      sectionOrder: ["chats", "projects"],
      showAllChats: false,
      expandedProjectThreadLists: {},
      projectThreadFetchLimits: {},
      projectThreadTotals: {},
      oneOffChatWorkspaceLoadLimit: 10,
      homeLoadPending: { chats: false, projects: {} },
    });
  });

  test("saves and loads items from cache", async () => {
    await saveToOfflineCache("test-key", { hello: "world" });
    const loaded = await loadFromOfflineCache<any>("test-key");
    expect(loaded).toEqual({ hello: "world" });
  });

  test("keeps desktop caches isolated even when both hosts use the same workspace path", async () => {
    await saveToOfflineCache("memories", [{ content: "Desktop A" }], "desktop-a");
    await saveToOfflineCache("memories", [{ content: "Desktop B" }], "desktop-b");
    expect(await loadFromOfflineCache("memories", "desktop-a")).toEqual([{ content: "Desktop A" }]);
    expect(await loadFromOfflineCache("memories", "desktop-b")).toEqual([{ content: "Desktop B" }]);
    await clearAllOfflineWorkspaceCache("desktop-a");
    expect(await loadFromOfflineCache("memories", "desktop-a")).toBeNull();
    expect(await loadFromOfflineCache("memories", "desktop-b")).toEqual([{ content: "Desktop B" }]);
    await clearAllOfflineWorkspaceCache("desktop-b");
  });

  test("does not show cached settings under a different workspace on the same desktop", async () => {
    await saveToOfflineCache(
      "memories",
      [{ content: "Workspace A" }],
      "desktop-one",
      "/workspace-a",
    );
    expect(await loadFromOfflineCache("memories", "desktop-one", "/workspace-b")).toBeNull();
    expect(await loadFromOfflineCache("memories", "desktop-one", "/workspace-a")).toEqual([
      { content: "Workspace A" },
    ]);
    await clearAllOfflineWorkspaceCache("desktop-one");
  });

  test("loads all offline workspace cache into Zustand stores", async () => {
    // Seed some data into the mock secure store
    await saveToOfflineCache("workspaces", [{ id: "w1", name: "Workspace 1", path: "/path/1" }]);
    await saveToOfflineCache("activeWorkspaceId", "w1");
    await saveToOfflineCache("activeWorkspaceCwd", "/path/1");
    await saveToOfflineCache(
      "providerCatalog",
      [{ id: "p1", name: "Provider 1" }],
      undefined,
      "/path/1",
    );

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

  test("does not replace a live workspace or provider refresh with late cached state", async () => {
    await saveToOfflineCache("workspaces", [{ id: "cached", name: "Cached", path: "/cached" }]);
    await saveToOfflineCache("activeWorkspaceId", "cached");
    await saveToOfflineCache("activeWorkspaceCwd", "/cached");
    await saveToOfflineCache("providerCatalog", [{ id: "cached-provider" }]);

    const hydration = loadAllOfflineWorkspaceCache();
    useWorkspaceStore.setState({
      workspaces: [{ id: "live", name: "Live", path: "/live" }],
      activeWorkspaceId: "live",
      activeWorkspaceCwd: "/live",
    });
    useProviderStore.setState({ catalog: [{ id: "live-provider" } as never] });
    await hydration;

    expect(useWorkspaceStore.getState().activeWorkspaceCwd).toBe("/live");
    expect(useWorkspaceStore.getState().workspaces[0]?.id).toBe("live");
    expect(useProviderStore.getState().catalog[0]?.id).toBe("live-provider");
  });

  test.each([1, 2, 3])(
    "preserves healthy drafts from v%i cache rows without attachment arrays",
    async (version) => {
      await saveToOfflineCache("threadSnapshots", {
        version,
        threads: [
          null,
          { id: "broken", composerAttachments: "invalid" },
          {
            id: "draft-healthy",
            title: "My draft",
            composerDraft: "Keep this text",
            feed: [],
          },
        ],
        snapshots: {},
      });

      const cached = await loadThreadOfflineCache();
      expect(cached?.threads).toHaveLength(1);
      expect(cached?.threads[0]).toMatchObject({
        id: "draft-healthy",
        composerDraft: "Keep this text",
        composerAttachments: [],
        composerSubmission: null,
      });
    },
  );

  test("migrates legacy unsent text without attributing another desktop's transcript or file paths", async () => {
    await clearLegacyOfflineCache();
    try {
      await secureStore.setItemAsync(
        "cowork.cache.threadSnapshots",
        JSON.stringify({
          version: 1,
          threads: [
            {
              id: "remote-legacy",
              title: "Legacy conversation",
              composerDraft: "Keep my current draft",
              composerAttachments: [
                {
                  type: "uploadedFile",
                  filename: "notes.txt",
                  path: "/old-desktop/notes.txt",
                  mimeType: "text/plain",
                },
              ],
              composerSubmission: {
                clientMessageId: "interrupted",
                text: "Keep the interrupted send too",
                attachments: [],
                status: "submitting",
              },
              feed: [
                {
                  id: "private",
                  kind: "message",
                  role: "assistant",
                  ts: "",
                  text: "Old host transcript",
                },
              ],
              cwd: "/old-desktop",
              workspaceId: "old",
            },
          ],
          snapshots: {},
        }),
      );
      const recovered = await loadThreadOfflineCache("new-desktop");
      expect(recovered?.threads.map((thread) => thread.composerDraft)).toEqual([
        "Keep my current draft",
        "Keep the interrupted send too",
      ]);
      for (const thread of recovered?.threads ?? []) {
        expect(thread.id).toStartWith("draft-");
        expect(thread.feed).toEqual([]);
        expect(thread.cwd).toBeNull();
        expect(thread.composerAttachments).toEqual([]);
      }
      expect(recovered?.threads[0]?.title).toContain("reattach files");
      expect(await loadThreadOfflineCache("another-desktop")).toBeNull();
      expect(await secureStore.getItemAsync("cowork.cache.threadSnapshots")).not.toBeNull();
    } finally {
      await clearLegacyOfflineCache();
      await clearAllOfflineWorkspaceCache("new-desktop");
    }
  });

  test("an interrupted unpaired transfer retries only on its owner without duplicating drafts", async () => {
    await clearLegacyOfflineCache();
    await clearAllOfflineWorkspaceCache(null);
    const deleteItem = secureStore.deleteItemAsync;
    const deleteSpy = spyOn(secureStore, "deleteItemAsync").mockImplementation(async (key) => {
      if (key === "cowork.cache.v2.unpaired.threadSnapshots") {
        throw new Error("Storage cleanup interrupted");
      }
      await deleteItem(key);
    });
    try {
      await saveToOfflineCache(
        "threadSnapshots",
        {
          version: 4,
          threads: [
            { id: "draft-recovery", title: "Unpaired draft", composerDraft: "Keep unpaired work" },
          ],
          snapshots: {},
        },
        null,
      );
      await saveToOfflineCache(
        "threadSnapshots",
        {
          version: 4,
          threads: [
            {
              id: "draft-recovery",
              title: "Existing draft",
              composerDraft: "Keep existing desktop work",
            },
          ],
          snapshots: {},
        },
        "recovery-owner",
      );

      await expect(loadThreadOfflineCache("recovery-owner")).rejects.toThrow(
        "Storage cleanup interrupted",
      );
      expect((await loadThreadOfflineCache(null))?.threads[0]?.composerDraft).toBe(
        "Keep unpaired work",
      );
      expect(await loadThreadOfflineCache("other-recovery-desktop")).toBeNull();
      deleteSpy.mockRestore();

      const recovered = await loadThreadOfflineCache("recovery-owner");
      expect(recovered?.threads.map((thread) => thread.composerDraft)).toEqual([
        "Keep existing desktop work",
        "Keep unpaired work",
      ]);
      expect(new Set(recovered?.threads.map((thread) => thread.id)).size).toBe(2);
      expect((await loadThreadOfflineCache("recovery-owner"))?.threads).toEqual(recovered?.threads);
      expect(await loadThreadOfflineCache(null)).toBeNull();
      expect(await loadThreadOfflineCache("other-recovery-desktop")).toBeNull();
    } finally {
      deleteSpy.mockRestore();
      await clearAllOfflineWorkspaceCache(null);
      await clearAllOfflineWorkspaceCache("recovery-owner");
      await clearAllOfflineWorkspaceCache("other-recovery-desktop");
      await clearLegacyOfflineCache();
    }
  });

  test("forgetting removes only the forgotten desktop's pending draft recovery", async () => {
    await clearLegacyOfflineCache();
    await clearAllOfflineWorkspaceCache(null);
    try {
      await saveToOfflineCache(
        "threadSnapshots",
        {
          version: 4,
          threads: [
            {
              id: "draft-owned-recovery",
              title: "Recovered draft",
              composerDraft: "Private recovery for A",
            },
          ],
          snapshots: {},
        },
        null,
      );
      expect(await claimOfflineDraftRecovery("recovery-desktop-a")).toBe(true);

      await clearLegacyOfflineCache("recovery-desktop-b");
      expect(await loadThreadOfflineCache("recovery-desktop-b")).toBeNull();
      expect((await loadThreadOfflineCache(null))?.threads[0]?.composerDraft).toBe(
        "Private recovery for A",
      );

      await clearLegacyOfflineCache("recovery-desktop-a");
      expect(await loadThreadOfflineCache(null)).toBeNull();
      expect(await loadThreadOfflineCache("recovery-desktop-b")).toBeNull();
      expect(await claimOfflineDraftRecovery("recovery-desktop-b")).toBe(true);
    } finally {
      await clearAllOfflineWorkspaceCache(null);
      await clearAllOfflineWorkspaceCache("recovery-desktop-a");
      await clearAllOfflineWorkspaceCache("recovery-desktop-b");
      await clearLegacyOfflineCache();
    }
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
          composerAttachments: [],
          composerSubmission: null,
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
      sectionOrder: ["chats", "projects"],
      showAllChats: false,
      expandedProjectThreadLists: {},
      projectThreadFetchLimits: {},
      projectThreadTotals: {},
      oneOffChatWorkspaceLoadLimit: 10,
    });
    await clearAllOfflineWorkspaceCache();
    const loaded = await loadFromOfflineCache("workspaces");
    expect(loaded).toBeNull();
    expect(await loadThreadOfflineCache()).toBeNull();
  });

  test.each([1, 2, 3, 4])(
    "hydrates v%i history without obsolete section state",
    async (version) => {
      await saveThreadOfflineCache({
        ...defaultThreadHomeUiState(),
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
            composerDraft: "keep this exact draft after restart",
            composerAttachments: [
              {
                type: "uploadedFile",
                filename: "notes.txt",
                path: "/path/1/notes.txt",
                mimeType: "text/plain",
              },
            ],
            composerSubmission: {
              clientMessageId: "stable-pending-message",
              text: "keep this exact draft after restart",
              attachments: [],
              status: "submitting",
              error: null,
            },
            pendingPrompt: true,
            pendingServerRequest: {
              kind: "ask",
              method: "item/tool/requestUserInput",
              requestId: "req-1",
              requestFingerprint: "req-1",
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
        sectionOrder: ["projects", "chats"],
        showAllChats: true,
        expandedProjectThreadLists: { w1: true },
        projectThreadFetchLimits: { w1: 15 },
        projectThreadTotals: { w1: 23 },
        oneOffChatWorkspaceLoadLimit: 20,
      });
      const stored = await loadFromOfflineCache<ThreadOfflineCache>("threadSnapshots");
      await saveToOfflineCache("threadSnapshots", {
        ...stored,
        version,
        sectionsOpen: version % 2 === 0 ? { chats: false, projects: false } : "obsolete",
      });

      const cached = await loadThreadOfflineCache();
      expect(cached?.version).toBe(4);
      expect(cached?.threads[0]).toMatchObject({
        id: "thread-cache-1",
        composerDraft: "keep this exact draft after restart",
        composerAttachments: [
          {
            type: "uploadedFile",
            filename: "notes.txt",
            path: "/path/1/notes.txt",
            mimeType: "text/plain",
          },
        ],
        composerSubmission: {
          clientMessageId: "stable-pending-message",
          text: "keep this exact draft after restart",
          status: "failed",
        },
        pendingPrompt: false,
        pendingServerRequest: null,
      });
      expect(cached?.snapshots["thread-cache-1"]?.hasPendingAsk).toBe(false);

      useThreadStore.getState().hydrateOfflineCache(cached!);
      expect(useThreadStore.getState().threads[0]?.title).toBe("Cached Thread");
      expect(useThreadStore.getState().threads[0]?.feed[0]?.id).toBe("msg-1");
      expect(useThreadStore.getState().threads[0]?.composerDraft).toBe(
        "keep this exact draft after restart",
      );
      expect(useThreadStore.getState().threads[0]?.composerSubmission).toMatchObject({
        clientMessageId: "stable-pending-message",
        status: "failed",
      });
      expect(useThreadStore.getState().expandedWorkspaceIds.w1).toBe(true);
      expect(useThreadStore.getState()).toMatchObject({
        sectionOrder: ["projects", "chats"],
        showAllChats: true,
        expandedProjectThreadLists: { w1: true },
        projectThreadFetchLimits: { w1: 15 },
        projectThreadTotals: { w1: 23 },
        oneOffChatWorkspaceLoadLimit: 20,
      });
      expect(cached).not.toHaveProperty("sectionsOpen");
      useThreadStore.getState().setSectionOrder(["chats", "projects"]);
      await flushThreadOfflineCache();
      const resaved = await loadFromOfflineCache<ThreadOfflineCache>("threadSnapshots");
      expect(resaved?.version).toBe(4);
      expect(resaved).not.toHaveProperty("sectionsOpen");
      expect(resaved?.snapshots["thread-cache-1"]?.feed).toEqual(cached?.threads[0]?.feed);
      expect(resaved?.threads[0]?.composerAttachments).toEqual(
        cached?.threads[0]?.composerAttachments,
      );
    },
  );

  test("bounds cached history without duplicating feeds or evicting authored drafts", async () => {
    useThreadStore.getState().seedThread();
    await flushThreadOfflineCache();
    const base = useThreadStore.getState().threads[0]!;
    const snapshot = useThreadStore.getState().snapshots[base.id]!;
    const feed = Array.from({ length: 450 }, (_, index) => ({
      id: `message-${index}`,
      kind: "message" as const,
      role: "assistant" as const,
      ts: "2026-01-01T00:00:00.000Z",
      text: `Response ${index}: ${"long cached content ".repeat(10)}`,
    }));
    const threads = Array.from({ length: 105 }, (_, index) => ({
      ...base,
      id: `cached-${index}`,
      feed: index === 0 ? feed : [],
    }));
    threads[102]!.composerDraft = "Keep this exact unsent text beyond the history window.";
    threads[103]!.composerSubmission = {
      clientMessageId: "interrupted-send",
      text: "Keep the interrupted submission too.",
      attachments: [],
      status: "submitting",
      error: null,
    };
    threads[104]!.composerAttachments = [
      {
        type: "file",
        filename: "draft.txt",
        mimeType: "text/plain",
        contentBase64: "ZGlzY3JldGUgZHJhZnQ=",
      },
    ];
    await saveThreadOfflineCache({
      ...defaultThreadHomeUiState(),
      threads,
      snapshots: { "cached-0": { ...snapshot, sessionId: "cached-0", feed } },
    });

    const stored = await loadFromOfflineCache<ThreadOfflineCache>("threadSnapshots");
    expect(stored?.threads).toHaveLength(103);
    expect(stored?.threads[0]?.feed).toEqual([]);
    expect(stored?.snapshots["cached-0"]?.feed).toEqual(feed.slice(-200));
    expect(stored?.threads.some((thread) => thread.id === "cached-101")).toBe(false);

    const restored = await loadThreadOfflineCache();
    expect(restored?.threads[0]?.feed).toEqual(feed.slice(-200));
    expect(restored?.threads.find((thread) => thread.id === "cached-102")?.composerDraft).toBe(
      threads[102]!.composerDraft,
    );
    expect(
      restored?.threads.find((thread) => thread.id === "cached-103")?.composerSubmission,
    ).toMatchObject({
      clientMessageId: "interrupted-send",
      text: "Keep the interrupted submission too.",
      status: "failed",
    });
    expect(
      restored?.threads.find((thread) => thread.id === "cached-104")?.composerAttachments,
    ).toEqual(threads[104]!.composerAttachments);
    expect(threads[0]?.feed).toHaveLength(450);
  });
});
