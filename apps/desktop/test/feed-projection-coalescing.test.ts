import { afterEach, describe, expect, test } from "bun:test";
import type { AppStoreState, StoreSet } from "../src/app/store.helpers";
import { defaultThreadRuntime } from "../src/app/store.helpers";
import { __internal as persistenceInternal } from "../src/app/store.helpers/persistence";
import { createThreadEventReducerContext } from "../src/app/store.helpers/threadEventReducer/context";
import {
  composeFeedItemUpdates,
  createFeedProjectionModule,
} from "../src/app/store.helpers/threadEventReducer/feedProjection";
import { createHandlersModule } from "../src/app/store.helpers/threadEventReducer/handlers";
import { createMessagingModule } from "../src/app/store.helpers/threadEventReducer/messaging";
import { createWorkspaceStateHelpers } from "../src/app/store.helpers/threadEventReducer/workspaceState";
import type { FeedItem, ThreadRecord } from "../src/app/types";

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

type FrameHarness = {
  flushFrame(): void;
  pendingFrames(): number;
};

function installFakeAnimationFrame(): FrameHarness {
  const callbacks: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  return {
    flushFrame: () => {
      const pending = callbacks.splice(0);
      for (const callback of pending) {
        callback(16.67);
      }
    },
    pendingFrames: () => callbacks.length,
  };
}

function makeThread(id: string): ThreadRecord {
  return {
    id,
    workspaceId: "workspace-1",
    title: id,
    titleSource: "manual",
    createdAt: "2026-07-09T00:00:00.000Z",
    lastMessageAt: "2026-07-09T00:00:00.000Z",
    status: "active",
    sessionId: id,
    messageCount: 0,
    lastEventSeq: 0,
    draft: false,
  };
}

function createFeedHarness(threadIds: string[]) {
  let publications = 0;
  let state = {
    threads: threadIds.map(makeThread),
    threadRuntimeById: Object.fromEntries(
      threadIds.map((threadId) => [
        threadId,
        { ...defaultThreadRuntime(), sessionId: threadId, hydrating: false },
      ]),
    ),
    latestTodosByThreadId: {},
    notifications: [],
    workspaceExplorerRefreshById: {},
    refreshWorkspaceFiles: async () => {},
    applyWorkspaceDefaultsToThread: async () => {},
    selectedThreadId: threadIds[0] ?? null,
  } as unknown as AppStoreState;
  const set: StoreSet = (partial) => {
    const patch = typeof partial === "function" ? partial(state) : partial;
    publications += 1;
    state = { ...state, ...patch };
  };
  const ctx = createThreadEventReducerContext({
    nowIso: () => "2026-07-09T00:00:00.000Z",
    makeId: () => "generated-id",
    persist: () => {},
    appendThreadTranscript: () => {},
    pushNotification: (notifications, entry) => [...notifications, entry],
    normalizeThreadTitleSource: () => "manual",
    shouldAdoptServerTitle: () => true,
  });
  const workspace = createWorkspaceStateHelpers(ctx);
  const feed = createFeedProjectionModule(ctx, workspace);
  const messaging = createMessagingModule(ctx, workspace, feed);
  const handlers = createHandlersModule(ctx, workspace, feed, messaging);
  return {
    feed,
    get: () => state,
    handleThreadEvent: handlers.handleThreadEvent,
    publications: () => publications,
    resetPublications: () => {
      publications = 0;
    },
    selectThread: (threadId: string) => {
      state = { ...state, selectedThreadId: threadId };
    },
    set,
  };
}

function messageText(state: AppStoreState, threadId: string, itemId: string): string | null {
  const item = state.threadRuntimeById[threadId]?.feed.find((entry) => entry.id === itemId);
  return item?.kind === "message" ? item.text : null;
}

function reasoningText(state: AppStoreState, threadId: string, itemId: string): string | null {
  const item = state.threadRuntimeById[threadId]?.feed.find((entry) => entry.id === itemId);
  return item?.kind === "reasoning" ? item.text : null;
}

function assistantText(state: AppStoreState, threadId: string): string | null {
  const item = state.threadRuntimeById[threadId]?.feed.find(
    (entry) => entry.kind === "message" && entry.role === "assistant",
  );
  return item?.kind === "message" ? item.text : null;
}

afterEach(() => {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
});

describe("model-stream feed update coalescing", () => {
  test("preserves an earlier text delta when a later update adds annotations", () => {
    const item: FeedItem = {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      ts: "2026-07-09T00:00:00.000Z",
      text: "Hello",
    };
    const update = composeFeedItemUpdates(
      (current) =>
        current.kind === "message" ? { ...current, text: `${current.text} world` } : current,
      (current) =>
        current.kind === "message"
          ? { ...current, annotations: [{ type: "citation", url: "https://example.com" }] }
          : current,
    );

    expect(update(item)).toEqual({
      ...item,
      text: "Hello world",
      annotations: [{ type: "citation", url: "https://example.com" }],
    });
  });

  test("publishes interleaved assistant and reasoning deltas once per frame", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1", "thread-2"]);

    harness.feed.applyProjectedAssistantDeltaToThread(harness.set, "thread-1", "assistant-1", "A");
    harness.feed.applyProjectedReasoningDeltaToThread(
      harness.set,
      "thread-2",
      "reasoning-2",
      "reasoning",
      "R",
    );
    harness.feed.applyProjectedAssistantDeltaToThread(harness.set, "thread-1", "assistant-1", "B");
    harness.feed.applyProjectedReasoningDeltaToThread(
      harness.set,
      "thread-2",
      "reasoning-2",
      "summary",
      "S",
    );

    expect(harness.publications()).toBe(0);
    expect(animationFrame.pendingFrames()).toBe(1);

    animationFrame.flushFrame();

    expect(harness.publications()).toBe(1);
    expect(messageText(harness.get(), "thread-1", "assistant-1")).toBe("AB");
    expect(reasoningText(harness.get(), "thread-2", "reasoning-2")).toBe("RS");
  });

  test("keeps 1,000 deltas ordered inside one frame publication", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1"]);

    for (let index = 0; index < 1_000; index += 1) {
      harness.feed.applyProjectedAssistantDeltaToThread(
        harness.set,
        "thread-1",
        "assistant-1",
        `${index},`,
      );
    }
    animationFrame.flushFrame();

    expect(harness.publications()).toBe(1);
    expect(messageText(harness.get(), "thread-1", "assistant-1")).toBe(
      Array.from({ length: 1_000 }, (_, index) => `${index},`).join(""),
    );
  });

  test("keeps pending thread deltas correct when the active chat switches", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1", "thread-2", "thread-3"]);
    const untouchedRuntime = harness.get().threadRuntimeById["thread-3"];

    harness.feed.applyProjectedAssistantDeltaToThread(
      harness.set,
      "thread-1",
      "assistant-1",
      "first",
    );
    harness.selectThread("thread-2");
    harness.feed.applyProjectedAssistantDeltaToThread(
      harness.set,
      "thread-2",
      "assistant-2",
      "second",
    );
    animationFrame.flushFrame();

    expect(harness.publications()).toBe(1);
    expect(messageText(harness.get(), "thread-1", "assistant-1")).toBe("first");
    expect(messageText(harness.get(), "thread-2", "assistant-2")).toBe("second");
    expect(harness.get().threadRuntimeById["thread-3"]).toBe(untouchedRuntime);
  });

  test("keeps legacy chunk and raw background publications off global thread state", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1", "thread-2", "thread-3"]);
    const threads = harness.get().threads;
    const selectedRuntime = harness.get().threadRuntimeById["thread-1"];

    harness.handleThreadEvent(harness.get, harness.set, "thread-2", {
      type: "model_stream_chunk",
      sessionId: "thread-2",
      turnId: "chunk-turn",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: "chunk-stream", text: "chunk-background" },
    });
    harness.handleThreadEvent(harness.get, harness.set, "thread-3", {
      type: "model_stream_raw",
      sessionId: "thread-3",
      turnId: "raw-turn",
      index: 0,
      provider: "codex-cli",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "raw-stream", type: "message", role: "assistant", content: [] },
      },
    });
    harness.handleThreadEvent(harness.get, harness.set, "thread-3", {
      type: "model_stream_raw",
      sessionId: "thread-3",
      turnId: "raw-turn",
      index: 1,
      provider: "codex-cli",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        item_id: "raw-stream",
        part: { type: "output_text", text: "", annotations: [] },
      },
    });
    harness.handleThreadEvent(harness.get, harness.set, "thread-3", {
      type: "model_stream_raw",
      sessionId: "thread-3",
      turnId: "raw-turn",
      index: 2,
      provider: "codex-cli",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "raw-stream",
        delta: "raw-background",
      },
    });

    expect(harness.publications()).toBe(0);
    animationFrame.flushFrame();

    expect(harness.publications()).toBe(1);
    expect(harness.get().threads).toBe(threads);
    expect(harness.get().threadRuntimeById["thread-1"]).toBe(selectedRuntime);
    expect(assistantText(harness.get(), "thread-2")).toBe("chunk-background");
    expect(assistantText(harness.get(), "thread-3")).toBe("raw-background");
    expect(harness.get().threadRuntimeById["thread-2"]?.lastEventSeq).toBe(1);
    expect(harness.get().threadRuntimeById["thread-3"]?.lastEventSeq).toBe(3);

    const persistedThreads = persistenceInternal.buildPersistableThreads(harness.get());
    expect(persistedThreads.find((thread) => thread.id === "thread-2")?.lastEventSeq).toBe(1);
    expect(persistedThreads.find((thread) => thread.id === "thread-3")?.lastEventSeq).toBe(3);
  });

  test("flushes an existing streamed tool immediately when approval is requested", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1"]);

    harness.handleThreadEvent(harness.get, harness.set, "thread-1", {
      type: "model_stream_chunk",
      sessionId: "thread-1",
      turnId: "tool-turn",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_input_start",
      part: { id: "tool-1", toolName: "bash", input: { command: "bun test" } },
    });
    animationFrame.flushFrame();
    harness.resetPublications();

    harness.handleThreadEvent(harness.get, harness.set, "thread-1", {
      type: "model_stream_chunk",
      sessionId: "thread-1",
      turnId: "tool-turn",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_approval_request",
      part: {
        approvalId: "approval-1",
        toolCall: { toolName: "bash", input: { command: "bun test" } },
      },
    });

    const tool = harness
      .get()
      .threadRuntimeById["thread-1"]?.feed.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      state: "approval-requested",
      approval: { approvalId: "approval-1" },
    });
    expect(harness.publications()).toBe(1);

    animationFrame.flushFrame();
    expect(harness.publications()).toBe(1);
  });

  test("keeps one legacy assistant stream across a busy thread resume", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1", "thread-2"]);
    const turnId = "switch-turn";
    const streamId = "switch-stream";

    harness.handleThreadEvent(harness.get, harness.set, "thread-1", {
      type: "session_busy",
      sessionId: "thread-1",
      busy: true,
      turnId,
      cause: "user_message",
    });
    harness.handleThreadEvent(harness.get, harness.set, "thread-1", {
      type: "model_stream_chunk",
      sessionId: "thread-1",
      turnId,
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: streamId, text: "before-switch" },
    });
    animationFrame.flushFrame();

    harness.selectThread("thread-2");
    harness.handleThreadEvent(harness.get, harness.set, "thread-1", {
      type: "server_hello",
      sessionId: "thread-1",
      config: {
        provider: "openai",
        model: "gpt-5.2",
        workingDirectory: "/workspace",
      },
      isResume: true,
      busy: true,
      turnId,
    });
    harness.handleThreadEvent(harness.get, harness.set, "thread-1", {
      type: "model_stream_chunk",
      sessionId: "thread-1",
      turnId,
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: streamId, text: "-after-switch" },
    });
    animationFrame.flushFrame();

    const assistantItems =
      harness
        .get()
        .threadRuntimeById["thread-1"]?.feed.filter(
          (item) => item.kind === "message" && item.role === "assistant",
        ) ?? [];
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]).toMatchObject({ text: "before-switch-after-switch" });
  });

  test("keeps an interrupt claim only when reconnecting to the same live turn", () => {
    const harness = createFeedHarness(["thread-1"]);
    harness.set((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        "thread-1": {
          ...state.threadRuntimeById["thread-1"]!,
          busy: true,
          activeTurnId: "turn-1",
          interruptPending: true,
        },
      },
    }));

    harness.handleThreadEvent(harness.get, harness.set, "thread-1", {
      type: "server_hello",
      sessionId: "thread-1",
      config: {
        provider: "openai",
        model: "gpt-5.2",
        workingDirectory: "/workspace",
      },
      isResume: true,
      busy: true,
      turnId: "turn-1",
    });
    expect(harness.get().threadRuntimeById["thread-1"]?.interruptPending).toBe(true);

    harness.handleThreadEvent(harness.get, harness.set, "thread-1", {
      type: "server_hello",
      sessionId: "thread-1",
      config: {
        provider: "openai",
        model: "gpt-5.2",
        workingDirectory: "/workspace",
      },
      isResume: true,
      busy: true,
      turnId: "turn-2",
    });
    expect(harness.get().threadRuntimeById["thread-1"]?.interruptPending).toBe(false);
  });

  test("flushes pending content synchronously before completion", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1"]);

    harness.feed.applyProjectedAssistantDeltaToThread(
      harness.set,
      "thread-1",
      "assistant-1",
      "streamed",
    );
    harness.feed.applyProjectedCompleted(harness.get, harness.set, "thread-1", {
      id: "assistant-1",
      type: "agentMessage",
      text: "streamed complete",
    });

    expect(messageText(harness.get(), "thread-1", "assistant-1")).toBe("streamed complete");
    expect(harness.publications()).toBe(2);

    animationFrame.flushFrame();
    expect(harness.publications()).toBe(2);
  });
});
