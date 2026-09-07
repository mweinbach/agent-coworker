import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FeedItem } from "../src/app/types";
import {
  type FeedDerivationWindowState,
  prepareFeedDerivationFeed,
  resolveFeedDerivationVisibleCount,
  selectFeedDerivationWindow,
} from "../src/ui/chat/feedWindow";
import { useFeedDerivationWindow } from "../src/ui/chat/useFeedDerivationWindow";
import { setupJsdom } from "./jsdomHarness";

function makeFeed(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    kind: "message" as const,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    ts: "2026-07-09T00:00:00.000Z",
    text: `Message ${index + 1}`,
  }));
}

describe("chat feed derivation window", () => {
  test("derives only the newest bounded page for a long transcript", () => {
    const feed = makeFeed(2_000);

    const window = selectFeedDerivationWindow(feed, 80);

    expect(window.hiddenCount).toBe(1_920);
    expect(window.feed).toHaveLength(80);
    expect(window.feed[0]?.id).toBe("message-1921");
    expect(window.feed.at(-1)?.id).toBe("message-2000");
  });

  test("returns the original feed reference once all history is visible", () => {
    const feed = makeFeed(40);

    expect(selectFeedDerivationWindow(feed, 80)).toEqual({
      feed,
      hiddenCount: 0,
    });
    expect(selectFeedDerivationWindow(feed, 80).feed).toBe(feed);
  });

  test("windows renderable transcript rows instead of trailing todo and hidden-event snapshots", () => {
    const messages = makeFeed(120);
    const snapshots: FeedItem[] = Array.from({ length: 120 }, (_, index) => ({
      id: `todos-${index}`,
      kind: "todos",
      ts: "2026-07-09T00:00:01.000Z",
      todos: [{ content: `Task ${index}`, status: "completed" }],
    }));
    const logs: FeedItem[] = Array.from({ length: 40 }, (_, index) => ({
      id: `log-${index}`,
      kind: "log",
      ts: "2026-07-09T00:00:02.000Z",
      line: `debug ${index}`,
    }));

    const derivationFeed = prepareFeedDerivationFeed([...messages, ...snapshots, ...logs], false);
    const window = selectFeedDerivationWindow(derivationFeed, 80);

    expect(derivationFeed).toHaveLength(120);
    expect(window.feed).toHaveLength(80);
    expect(window.feed[0]?.id).toBe("message-41");
    expect(window.feed.at(-1)?.id).toBe("message-120");
    expect(window.feed.every((item) => item.kind === "message")).toBe(true);
  });

  test("preserves each thread window and its oldest anchor across away arrivals", () => {
    const windows = new Map<string, FeedDerivationWindowState>([
      ["thread-a", { feedLength: 200, visibleCount: 200 }],
      ["thread-b", { feedLength: 200, visibleCount: 80 }],
    ]);
    const threadAFeed = makeFeed(203);

    const threadAVisibleCount = resolveFeedDerivationVisibleCount(
      windows.get("thread-a"),
      threadAFeed.length,
      80,
    );
    const threadBVisibleCount = resolveFeedDerivationVisibleCount(windows.get("thread-b"), 200, 80);
    const restoredThreadAWindow = selectFeedDerivationWindow(threadAFeed, threadAVisibleCount);

    expect(threadAVisibleCount).toBe(203);
    expect(threadBVisibleCount).toBe(80);
    expect(restoredThreadAWindow.hiddenCount).toBe(0);
    expect(restoredThreadAWindow.feed[1]?.id).toBe("message-2");
  });

  test("restores each expanded thread window and includes items appended while it was away", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const threadA = makeFeed(120);
      const threadB = makeFeed(120).map((item) => ({
        ...item,
        id: `thread-b-${item.id}`,
        text: `Thread B ${item.text}`,
      }));

      function Harness({ feed, threadId }: { feed: FeedItem[]; threadId: string }) {
        const { expandOlderFeed, windowedSourceFeed } = useFeedDerivationWindow(threadId, feed);
        return createElement(
          "div",
          null,
          createElement("output", { "data-testid": "first-item" }, windowedSourceFeed.feed[0]?.id),
          createElement("button", { onClick: expandOlderFeed, type: "button" }, "Expand history"),
        );
      }

      const render = async (threadId: string, feed: FeedItem[]) => {
        await act(async () => {
          root.render(createElement(Harness, { feed, threadId }));
        });
      };
      const firstItemId = () =>
        harness.dom.window.document.querySelector('[data-testid="first-item"]')?.textContent;
      const expand = async () => {
        const button = harness.dom.window.document.querySelector("button");
        if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing expand control");
        }
        await act(async () => button.click());
      };

      await render("thread-a", threadA);
      expect(firstItemId()).toBe("message-41");
      await expand();
      expect(firstItemId()).toBe("message-1");

      await render("thread-b", threadB);
      expect(firstItemId()).toBe("thread-b-message-41");
      await expand();
      expect(firstItemId()).toBe("thread-b-message-1");

      await render("thread-a", makeFeed(123));
      expect(firstItemId()).toBe("message-1");
      await render("thread-b", threadB);
      expect(firstItemId()).toBe("thread-b-message-1");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });
});
