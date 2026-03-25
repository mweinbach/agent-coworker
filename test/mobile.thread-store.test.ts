import { beforeEach, describe, expect, test } from "bun:test";

import type { SessionSnapshotLike } from "../apps/mobile/src/features/cowork/protocolTypes";
import { useThreadStore } from "../apps/mobile/src/features/cowork/threadStore";

function createSnapshot(threadId: string): SessionSnapshotLike {
  return {
    sessionId: threadId,
    title: "Thread",
    titleSource: "manual",
    provider: "opencode",
    model: "mobile-test",
    sessionKind: "primary",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messageCount: 0,
    lastEventSeq: 0,
    feed: [],
    agents: [],
    todos: [],
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

describe("mobile thread store", () => {
  beforeEach(() => {
    useThreadStore.setState({
      snapshots: {},
      threads: [],
      selectedThreadId: null,
      pendingRequests: {},
    });
  });

  test("appendAgentDelta accumulates assistant text across streaming chunks", () => {
    const threadId = "thread-1";
    const store = useThreadStore.getState();
    store.hydrate(createSnapshot(threadId));

    store.appendAgentDelta(threadId, "assistant-1", "Hello", new Date().toISOString());
    store.appendAgentDelta(threadId, "assistant-1", " world", new Date().toISOString());

    const message = useThreadStore.getState().currentFeed(threadId).find(
      (entry) => entry.id === "assistant-1" && entry.kind === "message",
    );

    expect(message).toEqual(expect.objectContaining({
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      text: "Hello world",
    }));
    expect(useThreadStore.getState().snapshots[threadId]?.lastEventSeq).toBe(2);
  });
});
