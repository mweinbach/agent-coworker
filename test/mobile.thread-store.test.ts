import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionSnapshotLike } from "../apps/mobile/src/features/cowork/protocolTypes";
import { useThreadStore } from "../apps/mobile/src/features/cowork/threadStore";

describe("mobile thread store offline draft preservation", () => {
  beforeEach(() => {
    // Manually force reset state since clearAll now preserves drafts
    useThreadStore.setState({
      snapshots: {},
      threads: [],
      selectedThreadId: null,
      pendingRequests: {},
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
      kind: "ask",
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
