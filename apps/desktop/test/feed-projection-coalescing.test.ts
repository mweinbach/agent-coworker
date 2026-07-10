import { afterEach, describe, expect, test } from "bun:test";
import type { AppStoreState, StoreSet } from "../src/app/store.helpers";
import { defaultThreadRuntime } from "../src/app/store.helpers";
import { createThreadEventReducerContext } from "../src/app/store.helpers/threadEventReducer/context";
import {
  composeFeedItemUpdates,
  createFeedProjectionModule,
} from "../src/app/store.helpers/threadEventReducer/feedProjection";
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
  const feed = createFeedProjectionModule(ctx, {
    resetLiveModelStreamRuntime: () => {},
  });
  return {
    feed,
    get: () => state,
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

  test("flushes pending content synchronously before completion", () => {
    const animationFrame = installFakeAnimationFrame();
    const harness = createFeedHarness(["thread-1"]);

    harness.feed.applyProjectedAssistantDeltaToThread(
      harness.set,
      "thread-1",
      "assistant-1",
      "streamed",
    );
    harness.feed.applyProjectedCompleted(harness.set, "thread-1", {
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
