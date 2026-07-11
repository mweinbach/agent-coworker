import { beforeEach, describe, expect, test } from "bun:test";
import { clearAllOfflineWorkspaceCache } from "../apps/mobile/src/features/cowork/offlineCache";
import type { SessionSnapshotLike } from "../apps/mobile/src/features/cowork/protocolTypes";
import { loadThreadOfflineCache } from "../apps/mobile/src/features/cowork/threadOfflineCache";
import { useThreadStore } from "../apps/mobile/src/features/cowork/threadStore";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mobile thread store offline draft preservation", () => {
  beforeEach(async () => {
    await clearAllOfflineWorkspaceCache();
    // Manually force reset state since clearAll now preserves drafts
    useThreadStore.setState({
      snapshots: {},
      threads: [],
      selectedThreadId: null,
      pendingRequests: {},
      activeTurnStartedAt: {},
      expandedWorkspaceIds: {},
    });
  });

  test("clearAll preserves local drafts but clears remote threads", () => {
    const store = useThreadStore.getState();
    // 1. Seed a local draft thread
    store.seedThread();
    const draftId = useThreadStore.getState().selectedThreadId!;
    expect(draftId.startsWith("draft-")).toBe(true);

    // 2. Hydrate a remote thread
    const remoteSnapshot: SessionSnapshotLike = {
      sessionId: "remote-1",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      lastEventSeq: 1,
      feed: [],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    };
    store.hydrate(remoteSnapshot);

    // Verify both exist
    expect(useThreadStore.getState().threads.length).toBe(2);

    // 3. Clear all
    useThreadStore.getState().clearAll();

    // Verify remote thread is gone but local draft thread is preserved
    const remainingThreads = useThreadStore.getState().threads;
    expect(remainingThreads.length).toBe(1);
    expect(remainingThreads[0].id).toBe(draftId);
  });

  test("removes a rejected optimistic message by client id", () => {
    useThreadStore.getState().hydrate({
      sessionId: "remote-send",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      messageCount: 0,
      lastEventSeq: 1,
      feed: [],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    });

    const store = useThreadStore.getState();
    store.appendOptimisticUserMessage("remote-send", "Retry me", "client-message-1");
    expect(store.currentFeed("remote-send").map((item) => item.id)).toContain("client-message-1");

    useThreadStore.getState().removeOptimisticUserMessage("remote-send", "client-message-1");

    expect(
      useThreadStore
        .getState()
        .currentFeed("remote-send")
        .map((item) => item.id),
    ).not.toContain("client-message-1");
  });

  test("retains the exact failed text and attachments for retry without overwriting edits", () => {
    useThreadStore.getState().hydrate({
      sessionId: "remote-transaction",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      messageCount: 0,
      lastEventSeq: 1,
      feed: [],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
    const attachment = {
      type: "uploadedFile" as const,
      filename: "notes.txt",
      path: "/workspace/User Uploads/notes.txt",
      mimeType: "text/plain",
    };
    const store = useThreadStore.getState();
    store.setComposerDraft("remote-transaction", "  exact draft\n");
    store.setComposerAttachments("remote-transaction", [attachment]);

    const submission = store.beginComposerSubmission("remote-transaction", "client-message-1");
    expect(submission).toMatchObject({
      clientMessageId: "client-message-1",
      text: "  exact draft\n",
      attachments: [attachment],
      status: "submitting",
    });

    useThreadStore.getState().setComposerDraft("remote-transaction", "new draft");
    useThreadStore.getState().setComposerAttachments("remote-transaction", []);
    useThreadStore
      .getState()
      .failComposerSubmission("remote-transaction", "client-message-1", "transport lost");

    const retry = useThreadStore.getState().retryComposerSubmission("remote-transaction");
    expect(retry).toMatchObject({
      clientMessageId: "client-message-1",
      text: "  exact draft\n",
      attachments: [attachment],
      status: "submitting",
    });

    useThreadStore.getState().acceptComposerSubmission("remote-transaction", "client-message-1");
    const thread = useThreadStore.getState().getThread("remote-transaction");
    expect(thread?.composerDraft).toBe("new draft");
    expect(thread?.composerAttachments).toEqual([]);
    expect(thread?.composerSubmission).toBeNull();
  });

  test("does not append a second optimistic row after server reconciliation", () => {
    useThreadStore.getState().hydrate({
      sessionId: "remote-dedupe",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      messageCount: 0,
      lastEventSeq: 1,
      feed: [],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
    const store = useThreadStore.getState();
    store.appendOptimisticUserMessage("remote-dedupe", "once", "client-message-1");
    store.appendStarted(
      "remote-dedupe",
      {
        id: "projected-user-message",
        type: "userMessage",
        content: [{ type: "text", text: "once" }],
        clientMessageId: "client-message-1",
      },
      "2026-07-10T00:00:00.000Z",
    );

    useThreadStore
      .getState()
      .appendOptimisticUserMessage("remote-dedupe", "once", "client-message-1");

    const userMessages = useThreadStore
      .getState()
      .currentFeed("remote-dedupe")
      .filter((item) => item.kind === "message" && item.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      id: "projected-user-message",
      clientMessageId: "client-message-1",
    });
  });

  test("syncRemoteThreads preserves composerDraft, local drafts, and existing feeds", () => {
    const store = useThreadStore.getState();

    // 1. Seed local draft
    store.seedThread();
    const draftId = useThreadStore.getState().selectedThreadId!;

    // 2. Hydrate a remote thread with some feed/messages and a composerDraft
    const remoteSnapshot: SessionSnapshotLike = {
      sessionId: "remote-1",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      lastEventSeq: 1,
      feed: [
        {
          id: "msg-1",
          kind: "message",
          role: "user",
          ts: new Date().toISOString(),
          text: "Hello server",
        },
      ],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    };
    store.hydrate(remoteSnapshot);
    store.setComposerDraft("remote-1", "my draft message");

    // 3. Perform syncRemoteThreads with the remote thread list
    // The server returns the remote thread, but with minimal info (no feed)
    const remoteThreadList = [
      {
        id: "remote-1",
        title: "Remote Thread Updated Title",
        preview: "Hello server",
        modelProvider: "opencode",
        model: "remote-session",
        cwd: "/workspace",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        lastEventSeq: 2,
        status: { type: "idle" },
      },
    ];

    useThreadStore.getState().syncRemoteThreads(remoteThreadList);

    // Verify state
    const currentThreads = useThreadStore.getState().threads;
    // Should have local draft + remote thread
    expect(currentThreads.length).toBe(2);

    const updatedRemote = currentThreads.find((t) => t.id === "remote-1")!;
    expect(updatedRemote.title).toBe("Remote Thread Updated Title");
    // Composer draft must be preserved!
    expect(updatedRemote.composerDraft).toBe("my draft message");
    // Feed must be preserved!
    expect(updatedRemote.feed.length).toBe(1);
    expect(updatedRemote.feed[0].id).toBe("msg-1");
  });

  test("hydrate merges empty feed with existing feed", () => {
    const store = useThreadStore.getState();

    // 1. Hydrate remote thread with existing feed
    const firstSnapshot: SessionSnapshotLike = {
      sessionId: "remote-1",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      lastEventSeq: 1,
      feed: [
        {
          id: "msg-1",
          kind: "message",
          role: "user",
          ts: new Date().toISOString(),
          text: "Hello",
        },
      ],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    };
    store.hydrate(firstSnapshot);

    // 2. Hydrate with an empty feed snapshot (e.g. from connection list-level hydration)
    const secondSnapshot: SessionSnapshotLike = {
      sessionId: "remote-1",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      lastEventSeq: 1,
      feed: [], // empty!
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    };
    store.hydrate(secondSnapshot);

    // Feed should be preserved!
    const finalSnapshot = useThreadStore.getState().snapshots["remote-1"];
    expect(finalSnapshot.feed.length).toBe(1);
    expect(finalSnapshot.feed[0].id).toBe("msg-1");
  });

  test("hydrate writes remote snapshots to the offline thread cache", async () => {
    useThreadStore.getState().hydrate({
      sessionId: "remote-cache",
      title: "Cached Remote",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      lastEventSeq: 1,
      feed: [
        {
          id: "msg-1",
          kind: "message",
          role: "assistant",
          ts: "2026-01-01T00:00:00.000Z",
          text: "Cached for later",
        },
      ],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
    await flushMicrotasks();

    const cached = await loadThreadOfflineCache();
    expect(cached?.threads.map((thread) => thread.id)).toEqual(["remote-cache"]);
    expect(cached?.snapshots["remote-cache"]?.feed[0]?.id).toBe("msg-1");
  });

  test("syncRemoteThreads preserves locally hydrated threads missing from bounded remote fetch", () => {
    const store = useThreadStore.getState();

    const hydratedSnapshot: SessionSnapshotLike = {
      sessionId: "remote-viewed",
      title: "Viewed Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      lastEventSeq: 3,
      feed: [
        {
          id: "msg-1",
          kind: "message",
          role: "user",
          ts: new Date().toISOString(),
          text: "Still here",
        },
      ],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    };
    store.hydrate(hydratedSnapshot);

    useThreadStore.setState((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === "remote-viewed"
          ? {
              ...thread,
              cwd: "/workspace/project-a",
              workspaceId: "ws-a",
              workspaceName: "Project A",
              workspaceKind: "project",
            }
          : thread,
      ),
    }));

    useThreadStore.getState().syncRemoteThreads([
      {
        id: "remote-other",
        title: "Other Thread",
        preview: "Different thread",
        modelProvider: "opencode",
        model: "remote-session",
        cwd: "/workspace/project-a",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        lastEventSeq: 1,
        status: { type: "idle" },
      },
    ]);

    const threads = useThreadStore.getState().threads;
    expect(threads.some((thread) => thread.id === "remote-viewed")).toBe(true);
    expect(threads.some((thread) => thread.id === "remote-other")).toBe(true);

    const viewed = threads.find((thread) => thread.id === "remote-viewed")!;
    expect(viewed.workspaceId).toBe("ws-a");
    expect(viewed.feed.length).toBe(1);
  });

  test("hydrate preserves workspace association when workspace lookup is unavailable", () => {
    const store = useThreadStore.getState();

    const snapshot: SessionSnapshotLike = {
      sessionId: "remote-1",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      lastEventSeq: 1,
      feed: [],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    };
    store.hydrate(snapshot);

    useThreadStore.setState((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === "remote-1"
          ? {
              ...thread,
              cwd: "/workspace/project-a",
              workspaceId: "ws-a",
              workspaceName: "Project A",
              workspaceKind: "project",
            }
          : thread,
      ),
    }));

    store.hydrate({
      ...snapshot,
      title: "Updated title",
      feed: [
        {
          id: "msg-1",
          kind: "message",
          role: "user",
          ts: new Date().toISOString(),
          text: "Hello",
        },
      ],
    });

    const thread = useThreadStore.getState().threads.find((entry) => entry.id === "remote-1")!;
    expect(thread.title).toBe("Updated title");
    expect(thread.workspaceId).toBe("ws-a");
    expect(thread.workspaceName).toBe("Project A");
    expect(thread.workspaceKind).toBe("project");
  });

  test("clearPendingRequestsOnDisconnect clears pending status", () => {
    const store = useThreadStore.getState();

    // 1. Hydrate a remote thread with pending request
    const snapshot: SessionSnapshotLike = {
      sessionId: "remote-1",
      title: "Remote Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "remote-session",
      sessionKind: "primary",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      lastEventSeq: 1,
      feed: [],
      agents: [],
      todos: [],
      hasPendingAsk: true,
      hasPendingApproval: false,
    };
    store.hydrate(snapshot);

    store.setPendingRequest({
      requestId: "req-123",
      requestFingerprint: "req-123",
      kind: "ask",
      method: "item/tool/requestUserInput",
      threadId: "remote-1",
      itemId: "item-1",
      question: "Continue?",
      options: ["yes", "no"],
    });

    expect(useThreadStore.getState().threads[0].pendingPrompt).toBe(true);
    expect(useThreadStore.getState().getPendingRequest("remote-1")).not.toBeNull();

    // 2. Call clearPendingRequestsOnDisconnect
    useThreadStore.getState().clearPendingRequestsOnDisconnect();

    expect(useThreadStore.getState().threads[0].pendingPrompt).toBe(false);
    expect(useThreadStore.getState().getPendingRequest("remote-1")).toBeNull();
    expect(useThreadStore.getState().snapshots["remote-1"].hasPendingAsk).toBe(false);
  });
});
