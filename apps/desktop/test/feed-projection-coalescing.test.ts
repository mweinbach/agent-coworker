import { afterEach, describe, expect, test } from "bun:test";
import type { AppStoreState, StoreSet } from "../src/app/store.helpers";
import { defaultThreadRuntime, RUNTIME } from "../src/app/store.helpers";
import {
  buildSyntheticServerHelloFromJsonRpcThread,
  buildSyntheticSessionInfoFromJsonRpcThread,
  buildSyntheticSessionSettings,
} from "../src/app/store.helpers/jsonRpcSocket";
import { createThreadEventReducerContext } from "../src/app/store.helpers/threadEventReducer/context";
import { createFeedProjectionModule } from "../src/app/store.helpers/threadEventReducer/feedProjection";
import { createHandlersModule } from "../src/app/store.helpers/threadEventReducer/handlers";
import { createMessagingModule } from "../src/app/store.helpers/threadEventReducer/messaging";
import { createWorkspaceStateHelpers } from "../src/app/store.helpers/threadEventReducer/workspaceState";
import type { FeedItem, SessionSnapshot, ThreadRecord } from "../src/app/types";
import type { SessionEvent } from "../src/lib/wsProtocol";

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

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "thread-1",
    title: "Current title",
    titleSource: "manual",
    titleModel: null,
    provider: "openai",
    model: "gpt-5.2",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: 0,
    nickname: null,
    taskType: null,
    targetPaths: null,
    profile: null,
    requestedModel: "gpt-5.2",
    effectiveModel: "gpt-5.2",
    requestedReasoningEffort: "high",
    effectiveReasoningEffort: "high",
    executionState: null,
    lastMessagePreview: "Completed answer",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:12.000Z",
    messageCount: 4,
    lastEventSeq: 12,
    feed: [],
    agents: [],
    workflowRuns: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: {
      turnId: "turn-current",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    },
    hasPendingAsk: false,
    hasPendingApproval: false,
    ...overrides,
  };
}

function createFeedHarness(threadIds: string[], makeId = () => "generated-id") {
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
    interactionsByThread: {},
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
    makeId,
    persist: () => {},
    appendThreadTranscript: () => {},
    pushNotification: (notifications, entry) => [...notifications, entry],
    normalizeThreadTitleSource: () => "manual",
    shouldAdoptServerTitle: () => true,
  });
  const workspace = createWorkspaceStateHelpers(ctx);
  const feed = createFeedProjectionModule(ctx);
  const messaging = createMessagingModule(ctx, workspace, feed);
  const handlers = createHandlersModule(ctx, feed, messaging);
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

afterEach(() => {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  RUNTIME.optimisticUserMessageIds.clear();
});

describe("projected feed update coalescing", () => {
  test("preserves completed same-ID content and metadata when a stale snapshot arrives after a turn", () => {
    const harness = createFeedHarness(["thread-1"]);
    const current = makeSnapshot({
      feed: [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          ts: "2026-07-09T00:00:12.000Z",
          text: "Completed answer",
        },
        {
          id: "tool-1",
          kind: "tool",
          ts: "2026-07-09T00:00:12.000Z",
          name: "read",
          state: "output-available",
          result: "File contents",
        },
      ],
      todos: [{ content: "Verify result", status: "completed" }],
    });
    harness.feed.applyJsonRpcThreadSnapshot(harness.get, harness.set, "thread-1", current);
    const stale = makeSnapshot({
      title: "Old title",
      requestedModel: "old-model",
      effectiveModel: "old-model",
      requestedReasoningEffort: "low",
      effectiveReasoningEffort: "low",
      updatedAt: "2026-07-09T00:00:04.000Z",
      messageCount: 2,
      lastEventSeq: 4,
      lastTurnUsage: null,
      feed: [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          ts: "2026-07-09T00:00:04.000Z",
          text: "Completed",
        },
        {
          id: "tool-1",
          kind: "tool",
          ts: "2026-07-09T00:00:04.000Z",
          name: "read",
          state: "input-streaming",
        },
      ],
    });

    harness.feed.applyJsonRpcThreadSnapshot(harness.get, harness.set, "thread-1", stale);

    expect(harness.get().threadRuntimeById["thread-1"]).toMatchObject({
      feed: current.feed,
      lastEventSeq: current.lastEventSeq,
      requestedModel: current.requestedModel,
      effectiveModel: current.effectiveModel,
      requestedReasoningEffort: current.requestedReasoningEffort,
      effectiveReasoningEffort: current.effectiveReasoningEffort,
      lastTurnUsage: current.lastTurnUsage,
    });
    expect(harness.get().threads[0]).toMatchObject({
      title: current.title,
      lastEventSeq: current.lastEventSeq,
      messageCount: current.messageCount,
      lastMessageAt: current.updatedAt,
    });
    expect(harness.get().latestTodosByThreadId["thread-1"]).toEqual(current.todos);
  });

  test("lets a forced recovery snapshot replace stale state while retaining optimistic messages", () => {
    const harness = createFeedHarness(["thread-1"]);
    const optimistic: FeedItem = {
      id: "client-1",
      kind: "message",
      role: "user",
      ts: "2026-07-09T00:00:12.000Z",
      text: "Next question",
    };
    const current = makeSnapshot({ feed: [optimistic] });
    harness.feed.applyJsonRpcThreadSnapshot(harness.get, harness.set, "thread-1", current);
    RUNTIME.optimisticUserMessageIds.set("thread-1", new Set([optimistic.id]));
    const recovered = makeSnapshot({
      title: "Recovered title",
      lastEventSeq: 4,
      messageCount: 2,
      updatedAt: "2026-07-09T00:00:04.000Z",
      lastTurnUsage: null,
      feed: [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          ts: "2026-07-09T00:00:04.000Z",
          text: "Recovered answer",
        },
      ],
    });

    harness.feed.applyJsonRpcThreadSnapshot(harness.get, harness.set, "thread-1", recovered, {
      forceFeed: true,
    });

    expect(harness.get().threadRuntimeById["thread-1"]).toMatchObject({
      feed: [...recovered.feed, optimistic],
      lastEventSeq: recovered.lastEventSeq,
      lastTurnUsage: recovered.lastTurnUsage,
    });
    expect(harness.get().threads[0]).toMatchObject({
      title: recovered.title,
      lastEventSeq: recovered.lastEventSeq,
      messageCount: recovered.messageCount,
      lastMessageAt: recovered.updatedAt,
    });
  });

  test("adopts newer snapshots for existing item identities", () => {
    const harness = createFeedHarness(["thread-1"]);
    const item: FeedItem = {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      ts: "2026-07-09T00:00:04.000Z",
      text: "Partial",
    };
    harness.feed.applyJsonRpcThreadSnapshot(
      harness.get,
      harness.set,
      "thread-1",
      makeSnapshot({ lastEventSeq: 4, feed: [item] }),
    );
    const completed = makeSnapshot({ feed: [{ ...item, text: "Completed answer" }] });

    harness.feed.applyJsonRpcThreadSnapshot(harness.get, harness.set, "thread-1", completed);

    expect(harness.get().threadRuntimeById["thread-1"]).toMatchObject({
      feed: completed.feed,
      lastEventSeq: completed.lastEventSeq,
    });
  });

  test("synthetic reconnect metadata does not make a newer server snapshot look stale", () => {
    const harness = createFeedHarness(["thread-1"]);
    const initial = makeSnapshot({
      feed: [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          ts: "2026-07-09T00:00:12.000Z",
          text: "Partial",
        },
      ],
    });
    harness.feed.applyJsonRpcThreadSnapshot(harness.get, harness.set, "thread-1", initial);
    const thread = {
      id: "thread-1",
      title: initial.title,
      modelProvider: initial.provider,
      model: initial.model,
      cwd: "/tmp/workspace",
      createdAt: initial.createdAt,
      updatedAt: initial.updatedAt,
      status: { type: "idle" },
    };
    const syntheticEvents = [
      buildSyntheticServerHelloFromJsonRpcThread(thread, { isResume: true }),
      buildSyntheticSessionSettings(harness.get().threadRuntimeById["thread-1"], undefined),
      buildSyntheticSessionInfoFromJsonRpcThread(thread),
    ];
    for (const event of syntheticEvents) {
      harness.handleThreadEvent(harness.get, harness.set, "thread-1", event as SessionEvent, {
        recordEventSequence: false,
      });
    }
    const latest = makeSnapshot({
      lastEventSeq: initial.lastEventSeq + 1,
      feed: [{ ...initial.feed[0]!, text: "Completed answer" } as FeedItem],
    });
    harness.feed.applyJsonRpcThreadSnapshot(harness.get, harness.set, "thread-1", latest);

    expect(harness.get().threadRuntimeById["thread-1"]).toMatchObject({
      feed: latest.feed,
      lastEventSeq: latest.lastEventSeq,
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

  test("does not rescan retained history for every interleaved delta in one thread", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1"]);
    let historicalIdReads = 0;
    const history: FeedItem[] = Array.from({ length: 1_998 }, (_, index) => ({
      get id() {
        historicalIdReads += 1;
        return `history-${index}`;
      },
      kind: "message",
      role: "user",
      ts: "2026-07-09T00:00:00.000Z",
      text: "Earlier message",
    }));
    const originalFeed: FeedItem[] = [
      ...history,
      {
        id: "assistant-1",
        kind: "message",
        role: "assistant",
        text: "Before",
        ts: "2026-07-09T00:00:00.000Z",
      },
      {
        id: "reasoning-1",
        kind: "reasoning",
        mode: "reasoning",
        text: "Reason",
        ts: "2026-07-09T00:00:00.000Z",
      },
    ];
    harness.set((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        "thread-1": { ...state.threadRuntimeById["thread-1"]!, feed: originalFeed },
      },
    }));
    harness.resetPublications();

    for (let index = 0; index < 100; index += 1) {
      harness.feed.applyProjectedAssistantDeltaToThread(
        harness.set,
        "thread-1",
        "assistant-1",
        "A",
      );
      harness.feed.applyProjectedReasoningDeltaToThread(
        harness.set,
        "thread-1",
        "reasoning-1",
        index === 99 ? "summary" : "reasoning",
        "R",
      );
    }
    animationFrame.flushFrame();

    // Measure work instead of elapsed time: unrelated history should be searched
    // only when first locating each active item, regardless of its delta count.
    expect(historicalIdReads).toBeLessThanOrEqual(history.length * 2);
    const updatedFeed = harness.get().threadRuntimeById["thread-1"]!.feed;
    expect(harness.publications()).toBe(1);
    expect(updatedFeed).not.toBe(originalFeed);
    expect(updatedFeed[0]).toBe(originalFeed[0]);
    expect(updatedFeed[1_998]).toMatchObject({ text: `Before${"A".repeat(100)}` });
    expect(updatedFeed[1_999]).toMatchObject({ mode: "summary", text: `Reason${"R".repeat(100)}` });
    expect(originalFeed[1_998]).toMatchObject({ text: "Before" });
    expect(originalFeed[1_999]).toMatchObject({ mode: "reasoning", text: "Reason" });
  });

  test.each(["assistant", "user"] as const)(
    "preserves first-match duplicate IDs and kind guards for a %s item",
    (role) => {
      const animationFrame = installFakeAnimationFrame();
      const harness = createFeedHarness(["thread-1"]);
      const originalFeed: FeedItem[] = [
        { id: "duplicate", kind: "message", role, text: "First", ts: "2026-07-09T00:00:00.000Z" },
        {
          id: "duplicate",
          kind: "message",
          role: "assistant",
          text: "Second",
          ts: "2026-07-09T00:00:00.000Z",
        },
      ];
      harness.set((state) => ({
        threadRuntimeById: {
          ...state.threadRuntimeById,
          "thread-1": { ...state.threadRuntimeById["thread-1"]!, feed: originalFeed },
        },
      }));
      const originalRuntime = harness.get().threadRuntimeById["thread-1"];
      harness.feed.applyProjectedAssistantDeltaToThread(harness.set, "thread-1", "duplicate", "A");
      harness.feed.applyProjectedReasoningDeltaToThread(
        harness.set,
        "thread-1",
        "duplicate",
        "reasoning",
        "Ignored",
      );
      harness.feed.applyProjectedAssistantDeltaToThread(harness.set, "thread-1", "duplicate", "B");
      animationFrame.flushFrame();

      const updatedRuntime = harness.get().threadRuntimeById["thread-1"]!;
      expect(updatedRuntime.feed[0]).toMatchObject({
        role,
        text: role === "assistant" ? "FirstAB" : "First",
      });
      expect(updatedRuntime.feed[1]).toBe(originalFeed[1]);
      expect(originalFeed[0]).toMatchObject({ text: "First" });
      if (role === "user") expect(updatedRuntime).toBe(originalRuntime);
    },
  );

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
