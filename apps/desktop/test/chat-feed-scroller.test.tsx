import { describe, expect, mock, test } from "bun:test";
import { act, type ComponentProps, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { SessionFeedItem } from "../../../src/shared/sessionSnapshot";
import type { ChatRenderItem } from "../src/ui/chat/activityGroups";
import { ChatViewContext } from "../src/ui/chat/ChatViewContext";
import type { MentionCatalog } from "../src/ui/chat/composerMentions";
import { selectFeedDerivationWindow } from "../src/ui/chat/feedWindow";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { type JsdomHarness, setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());

const { ChatFeed } = await import("../src/ui/chat/ChatFeed");
type ChatFeedProps = ComponentProps<typeof ChatFeed>;

const EMPTY_MENTION_CATALOG: MentionCatalog = {
  items: [],
  names: [],
  kindByName: new Map(),
};

class ControlledResizeObserver {
  static callbacks = new Set<ResizeObserverCallback>();
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControlledResizeObserver.callbacks.add(callback);
  }

  observe() {}
  unobserve() {}
  disconnect() {
    ControlledResizeObserver.callbacks.delete(this.callback);
  }

  static trigger() {
    for (const callback of ControlledResizeObserver.callbacks) {
      callback([], {} as ResizeObserver);
    }
  }
}

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 600,
    toJSON: () => ({}),
    top,
    width: 600,
    x: 0,
    y: top,
  } as DOMRect;
}

function itemHeight(item: Element, heights: ReadonlyMap<string, number>): number {
  const messageId = (item as HTMLElement).dataset.messageId;
  return messageId ? (heights.get(messageId) ?? 0) : 200;
}

function installScrollerGeometry(
  harness: JsdomHarness,
  heights: ReadonlyMap<string, number>,
  viewportHeight = 400,
  textAnchorOffsets: ReadonlyMap<string, number> = new Map(),
) {
  const { HTMLElement, Range } = harness.dom.window;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalRangeRect = Range.prototype.getBoundingClientRect;
  const originalRangeRects = Range.prototype.getClientRects;
  const originalClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );

  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.getAttribute("data-slot") === "message-scroller-viewport") {
      return rect(0, viewportHeight);
    }
    if (this.getAttribute("data-slot") === "message-scroller-item") {
      const viewport = this.closest('[data-slot="message-scroller-viewport"]') as HTMLElement;
      const content = this.parentElement;
      const items = Array.from(
        content?.querySelectorAll(':scope > [data-slot="message-scroller-item"]') ?? [],
      );
      const visualItems = items.slice(0, items.indexOf(this));
      const top =
        visualItems.reduce((sum, item) => sum + itemHeight(item, heights), 0) -
        (viewport?.scrollTop ?? 0);
      return rect(top, itemHeight(this, heights));
    }
    return originalRect.call(this);
  };

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (this.getAttribute("data-slot") === "message-scroller-viewport") {
        return viewportHeight;
      }
      return originalClientHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.getAttribute("data-slot") === "message-scroller-viewport") {
        const content = this.querySelector('[data-slot="message-scroller-content"]');
        const items = Array.from(
          content?.querySelectorAll(':scope > [data-slot="message-scroller-item"]') ?? [],
        );
        return items.reduce((sum, item) => sum + itemHeight(item, heights), 0);
      }
      return originalScrollHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? this.scrollTop;
    },
  });
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element =
      this.startContainer instanceof HTMLElement
        ? this.startContainer
        : this.startContainer.parentElement;
    const item = element?.closest<HTMLElement>('[data-slot="message-scroller-item"]');
    const messageId = item?.dataset.messageId;
    const offset = messageId ? textAnchorOffsets.get(messageId) : undefined;
    if (item && offset !== undefined) {
      return rect(item.getBoundingClientRect().top + offset, 16);
    }
    return originalRangeRect?.call(this) ?? rect(0, 0);
  };
  Range.prototype.getClientRects = function getClientRects() {
    const rangeRect = this.getBoundingClientRect();
    if (rangeRect.height > 0) {
      return {
        0: rangeRect,
        item: (index: number) => (index === 0 ? rangeRect : null),
        length: 1,
        [Symbol.iterator]: function* iterator() {
          yield rangeRect;
        },
      } as DOMRectList;
    }
    return (
      originalRangeRects?.call(this) ??
      ({
        item: () => null,
        length: 0,
        [Symbol.iterator]: function* iterator() {},
      } as DOMRectList)
    );
  };
}

function message(id: string, role: "assistant" | "user", text: string): ChatRenderItem {
  const item: SessionFeedItem = {
    id,
    kind: "message",
    role,
    text,
    ts: "2026-06-26T12:00:00.000Z",
  };
  return { kind: "feed-item", item };
}

function renderFeed(
  renderItems: ChatRenderItem[],
  selectedThreadId: string,
  hydrating = false,
  overrides: Partial<ChatFeedProps> = {},
) {
  return createElement(
    ChatViewContext.Provider,
    {
      value: {
        developerMode: false,
        mentionCatalog: EMPTY_MENTION_CATALOG,
      },
    },
    createElement(ChatFeed, {
      transcriptOnly: false,
      disconnected: false,
      visibleFeedLength: renderItems.length,
      hydrating,
      renderItems,
      liveActivityGroupId: null,
      liveStartedAt: null,
      showWorkingPlaceholder: false,
      citationUrlsByMessageId: new Map(),
      citationSourcesByMessageId: new Map(),
      desktopBasePath: null,
      latestRemovedSurfaceItemId: null,
      REMOVEDUIEnabled: false,
      bottomOffset: 200,
      interactions: [],
      onAnswerAsk: () => true,
      onAnswerApproval: () => true,
      onRetryInteraction: () => true,
      selectedThreadId,
      ...overrides,
    }),
  );
}

function setupScroller(
  heights: Map<string, number>,
  textAnchorOffsets: Map<string, number> = new Map(),
) {
  ControlledResizeObserver.callbacks.clear();
  const harness = setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: { ResizeObserver: ControlledResizeObserver },
  });
  installScrollerGeometry(harness, heights, 400, textAnchorOffsets);
  return harness;
}

async function waitForScrollTop(viewport: HTMLElement, expected: number, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let lastScrollTop = viewport.scrollTop;
  while (Date.now() < deadline) {
    if (lastScrollTop === expected) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    lastScrollTop = viewport.scrollTop;
  }
  expect(lastScrollTop).toBe(expected);
}

describe("desktop chat message scroller", () => {
  test("opens at the last visible user turn with a 64px previous-message peek", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["assistant-1", 500],
      ["user-2", 100],
      ["assistant-2", 500],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed(
            [
              message("user-1", "user", "First question"),
              message("assistant-1", "assistant", "First answer"),
              message("user-2", "user", "Second question"),
              message("assistant-2", "assistant", "Second answer"),
            ],
            "thread-a",
          ),
        );
      });

      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      expect(viewport?.scrollTop).toBe(536);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("reapplies last-anchor after an empty thread finishes hydrating", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["assistant-1", 500],
      ["user-2", 100],
      ["assistant-2", 500],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const hydratedItems = [
        message("user-1", "user", "First question"),
        message("assistant-1", "assistant", "First answer"),
        message("user-2", "user", "Second question"),
        message("assistant-2", "assistant", "Second answer"),
      ];

      await act(async () => {
        root.render(renderFeed([], "thread-a", true));
      });
      await act(async () => {
        root.render(renderFeed(hydratedItems, "thread-a"));
      });

      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      expect(viewport?.scrollTop).toBe(536);
      expect(container.querySelector('[data-message-id="user-2"]')).not.toBeNull();

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("moves a visible user turn from the middle of the viewport to the top anchor", async () => {
    const heights = new Map([
      ["assistant-intro", 200],
      ["user-1", 60],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed(
            [
              message("assistant-intro", "assistant", "Intro"),
              message("user-1", "user", "First question"),
            ],
            "thread-a",
          ),
        );
      });
      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewport) throw new Error("missing viewport");
      await waitForScrollTop(viewport, 136);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("anchors a newly appended user turn even with approvals and clearance rendered below it", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["assistant-1", 500],
      ["user-2", 100],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const initialItems = [
        message("user-1", "user", "First question"),
        message("assistant-1", "assistant", "First answer"),
      ];

      await act(async () => {
        root.render(renderFeed(initialItems, "thread-a"));
      });

      await act(async () => {
        root.render(
          renderFeed([...initialItems, message("user-2", "user", "Follow-up")], "thread-a"),
        );
      });
      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewport) throw new Error("missing viewport");
      await waitForScrollTop(viewport, 536);
      const children = Array.from(
        container.querySelector('[data-slot="message-scroller-content"]')?.children ?? [],
      ).filter((element) => element.getAttribute("data-slot") === "message-scroller-item");
      expect(
        children
          .map((element) => element.getAttribute("data-message-id"))
          .filter((messageId): messageId is string => Boolean(messageId)),
      ).toEqual(["user-1", "assistant-1", "user-2"]);
      expect(children.at(-1)?.querySelector('[data-slot="message-bar-reserved-space"]')).not.toBe(
        null,
      );

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("reserves the composer offset once when the working placeholder is visible", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["status:working-placeholder", 40],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed([message("user-1", "user", "Question")], "thread-a", false, {
            bottomOffset: 220,
            showWorkingPlaceholder: true,
          }),
        );
      });

      const reservedSpaces = container.querySelectorAll('[data-slot="message-bar-reserved-space"]');
      expect(reservedSpaces).toHaveLength(1);
      expect((reservedSpaces[0] as HTMLElement).style.height).toBe("220px");
      expect(container.querySelectorAll('[data-slot="working-placeholder"]')).toHaveLength(1);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("follows streaming at the live edge, stops after user scroll, and resumes after scroll-to-end", async () => {
    const heights = new Map([
      ["user-1", 60],
      ["assistant-1", 60],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed(
            [
              message("user-1", "user", "Question"),
              message("assistant-1", "assistant", "Streaming"),
            ],
            "thread-a",
          ),
        );
      });

      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewport) throw new Error("missing viewport");
      expect(viewport.scrollTop).toBe(0);

      heights.set("assistant-1", 500);
      await act(async () => {
        ControlledResizeObserver.trigger();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(viewport.scrollTop).toBe(360);

      viewport.scrollTop = 100;
      await act(async () => {
        viewport.dispatchEvent(new harness.dom.window.Event("wheel", { bubbles: true }));
        viewport.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      heights.set("assistant-1", 600);
      await act(async () => {
        ControlledResizeObserver.trigger();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(viewport.scrollTop).toBe(100);

      const scrollToEnd = container.querySelector(
        '[aria-label="Jump to latest"]',
      ) as HTMLButtonElement | null;
      expect(scrollToEnd).not.toBeNull();
      expect(scrollToEnd?.style.bottom).toBe("172px");
      expect(scrollToEnd?.className).toContain("bg-background/80");
      expect(scrollToEnd?.className).toContain("backdrop-blur-md");
      await act(async () => {
        scrollToEnd?.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(viewport.scrollTop).toBe(460);

      heights.set("assistant-1", 700);
      await act(async () => {
        ControlledResizeObserver.trigger();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(viewport.scrollTop).toBe(560);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("progressively windows long feeds and expands when scrolling near the top", async () => {
    const heights = new Map<string, number>();
    const items: ChatRenderItem[] = [];
    for (let index = 0; index < 100; index += 1) {
      const id = `msg-${index}`;
      heights.set(id, 40);
      items.push(message(id, index % 2 === 0 ? "user" : "assistant", `Message ${index}`));
    }
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      let visibleCount = 80;
      const renderWindow = () => {
        const windowedFeed = selectFeedDerivationWindow(items, visibleCount);
        root.render(
          renderFeed(windowedFeed.feed, "thread-long", false, {
            hiddenFeedItemCount: windowedFeed.hiddenCount,
            onExpandOlderFeed: () => {
              visibleCount = Math.min(items.length, visibleCount + 40);
              renderWindow();
            },
            onShowAllOlderFeed: () => {
              visibleCount = items.length;
              renderWindow();
            },
            visibleFeedLength: items.length,
          }),
        );
      };

      await act(async () => {
        renderWindow();
      });

      // Soft window keeps the newest 80 entries + show-older control.
      expect(container.querySelector('[data-message-id="msg-0"]')).toBeNull();
      expect(container.querySelector('[data-message-id="msg-19"]')).toBeNull();
      expect(container.querySelector('[data-message-id="msg-20"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="msg-99"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="status:show-older"]')).not.toBeNull();
      expect(
        (container.querySelector('[data-slot="feed-window-spacer"]') as HTMLElement | null)?.style
          .minHeight,
      ).toBe("");

      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewport) throw new Error("missing viewport");

      await act(async () => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Near-top scroll expands by another batch (80 → 100 mounts everything).
      expect(container.querySelector('[data-message-id="msg-0"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="status:show-older"]')).toBeNull();

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  }, 15_000);

  test("reapplies last-user-turn restoration when switching threads", async () => {
    const heights = new Map([
      ["user-a", 100],
      ["assistant-a", 700],
      ["assistant-b-intro", 200],
      ["user-b", 100],
      ["assistant-b", 500],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed(
            [message("user-a", "user", "A"), message("assistant-a", "assistant", "Answer A")],
            "thread-a",
          ),
        );
      });
      const viewportA = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      expect(viewportA?.scrollTop).toBe(0);

      await act(async () => {
        root.render(
          renderFeed(
            [
              message("assistant-b-intro", "assistant", "Intro"),
              message("user-b", "user", "B"),
              message("assistant-b", "assistant", "Answer B"),
            ],
            "thread-b",
          ),
        );
      });

      const viewportB = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      expect(viewportB).not.toBe(viewportA);
      if (!viewportB) throw new Error("missing viewport");
      await waitForScrollTop(viewportB, 136);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("restores the exact per-thread anchor and offset across A → B → A hydration", async () => {
    const heights = new Map([
      ["user-a-1", 100],
      ["assistant-a-1", 400],
      ["user-a-2", 100],
      ["assistant-a-2", 600],
      ["user-b", 100],
      ["assistant-b", 500],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const threadA = [
        message("user-a-1", "user", "A1"),
        message("assistant-a-1", "assistant", "Answer A1"),
        message("user-a-2", "user", "A2"),
        message("assistant-a-2", "assistant", "Answer A2"),
      ];

      await act(async () => {
        root.render(renderFeed(threadA, "thread-a"));
      });
      const viewportA = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewportA) throw new Error("missing thread A viewport");

      viewportA.scrollTop = 520;
      await act(async () => {
        viewportA.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -80 }),
        );
        viewportA.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });
      expect(viewportA.dataset.scrollMode).toBe("detached");
      expect(
        container.querySelector('[data-message-id="user-a-2"]')?.getBoundingClientRect().top,
      ).toBe(-20);

      await act(async () => {
        root.render(
          renderFeed(
            [message("user-b", "user", "B"), message("assistant-b", "assistant", "Answer B")],
            "thread-b",
          ),
        );
      });
      await act(async () => {
        root.render(renderFeed([], "thread-a", true));
      });
      await act(async () => {
        root.render(renderFeed(threadA, "thread-a"));
      });

      const restoredViewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      expect(restoredViewport?.scrollTop).toBe(520);
      expect(
        container.querySelector('[data-message-id="user-a-2"]')?.getBoundingClientRect().top,
      ).toBe(-20);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("persists the unread baseline and exact count while a detached thread is away", async () => {
    const heights = new Map([
      ["user-a", 100],
      ["assistant-a", 700],
      ["away-1", 100],
      ["away-2", 100],
      ["away-3", 100],
      ["away-4", 100],
      ["away-5", 100],
      ["user-b", 100],
      ["assistant-b", 500],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const initialThreadA = [
        message("user-a", "user", "Question A"),
        message("assistant-a", "assistant", "Answer A"),
      ];
      const threadB = [
        message("user-b", "user", "Question B"),
        message("assistant-b", "assistant", "Answer B"),
      ];

      await act(async () => {
        root.render(renderFeed(initialThreadA, "thread-a"));
      });
      const viewportA = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewportA) throw new Error("missing thread A viewport");
      viewportA.scrollTop = 100;
      await act(async () => {
        viewportA.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -80 }),
        );
        viewportA.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });

      await act(async () => {
        root.render(renderFeed(threadB, "thread-b"));
      });
      const firstAwayBatch = [
        message("away-1", "assistant", "Away one"),
        message("away-2", "assistant", "Away two"),
        message("away-3", "assistant", "Away three"),
      ];
      await act(async () => {
        root.render(renderFeed([...initialThreadA, ...firstAwayBatch], "thread-a"));
      });
      expect(
        container.querySelector('[aria-label="3 new messages. Jump to latest"]'),
      ).not.toBeNull();
      const firstRestoredViewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      expect(firstRestoredViewport?.scrollTop).toBe(100);

      await act(async () => {
        root.render(renderFeed(threadB, "thread-b"));
      });
      await act(async () => {
        root.render(
          renderFeed(
            [
              ...initialThreadA,
              ...firstAwayBatch,
              message("away-4", "assistant", "Away four"),
              message("away-5", "assistant", "Away five"),
            ],
            "thread-a",
          ),
        );
      });
      expect(
        container.querySelector('[aria-label="5 new messages. Jump to latest"]'),
      ).not.toBeNull();
      expect(
        (container.querySelector('[data-slot="message-scroller-viewport"]') as HTMLElement | null)
          ?.scrollTop,
      ).toBe(100);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("preserves a detached reading anchor through dynamic row height changes", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["assistant-1", 400],
      ["user-2", 100],
      ["assistant-2", 600],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed(
            [
              message("user-1", "user", "First"),
              message("assistant-1", "assistant", "First answer"),
              message("user-2", "user", "Second"),
              message("assistant-2", "assistant", "Second answer"),
            ],
            "thread-a",
          ),
        );
      });
      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewport) throw new Error("missing viewport");

      viewport.scrollTop = 520;
      await act(async () => {
        viewport.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -80 }),
        );
        viewport.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });
      expect(
        container.querySelector('[data-message-id="user-2"]')?.getBoundingClientRect().top,
      ).toBe(-20);

      heights.set("assistant-1", 600);
      await act(async () => {
        ControlledResizeObserver.trigger();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(viewport.scrollTop).toBe(720);
      expect(
        container.querySelector('[data-message-id="user-2"]')?.getBoundingClientRect().top,
      ).toBe(-20);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("compensates Markdown growth above the reading point within one row", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["assistant-1", 800],
    ]);
    const textAnchorOffsets = new Map([["assistant-1", 250]]);
    const harness = setupScroller(heights, textAnchorOffsets);

    try {
      const document = harness.dom.window.document;
      const container = document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed(
            [
              message("user-1", "user", "Prelude"),
              message(
                "assistant-1",
                "assistant",
                "Opening Markdown paragraph.\n\nReading point remains stable.",
              ),
            ],
            "thread-a",
          ),
        );
      });
      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      const anchorItem = container.querySelector(
        '[data-message-id="assistant-1"]',
      ) as HTMLElement | null;
      if (!viewport || !anchorItem) throw new Error("missing same-row anchor");
      const textWalker = document.createTreeWalker(anchorItem, 4);
      let readingNode = textWalker.nextNode();
      while (readingNode && !readingNode.textContent?.includes("Reading point")) {
        readingNode = textWalker.nextNode();
      }
      if (!readingNode) throw new Error("missing Markdown reading text");
      const caretNode = readingNode;
      const caretDocument = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      caretDocument.caretRangeFromPoint = () => {
        const range = document.createRange();
        range.setStart(caretNode, 0);
        range.collapse(true);
        return range;
      };

      viewport.scrollTop = 300;
      await act(async () => {
        viewport.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -80 }),
        );
        viewport.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });
      const readingRange = document.createRange();
      readingRange.setStart(caretNode, 0);
      readingRange.collapse(true);
      expect(readingRange.getBoundingClientRect().top).toBe(50);

      heights.set("assistant-1", 1_000);
      textAnchorOffsets.set("assistant-1", 450);
      await act(async () => {
        ControlledResizeObserver.trigger();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(viewport.scrollTop).toBe(500);
      expect(readingRange.getBoundingClientRect().top).toBe(50);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("preserves a detached anchor when the progressive feed window shifts", async () => {
    const heights = new Map([
      ["status:show-older", 1_000],
      ["old-user", 100],
      ["old-assistant", 100],
      ["anchor-user", 100],
      ["anchor-assistant", 600],
      ["new-user", 100],
      ["new-assistant", 200],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const initialItems = [
        message("old-user", "user", "Old question"),
        message("old-assistant", "assistant", "Old answer"),
        message("anchor-user", "user", "Reading anchor"),
        message("anchor-assistant", "assistant", "Anchor answer"),
      ];

      await act(async () => {
        root.render(
          renderFeed(initialItems, "thread-a", false, {
            hiddenFeedItemCount: 10,
          }),
        );
      });
      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewport) throw new Error("missing viewport");
      viewport.scrollTop = 1_250;
      await act(async () => {
        viewport.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -80 }),
        );
        viewport.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });
      expect(
        container.querySelector('[data-message-id="anchor-user"]')?.getBoundingClientRect().top,
      ).toBe(-50);

      heights.set("status:show-older", 1_240);
      await act(async () => {
        root.render(
          renderFeed(
            [
              message("anchor-user", "user", "Reading anchor"),
              message("anchor-assistant", "assistant", "Anchor answer"),
              message("new-user", "user", "New question"),
              message("new-assistant", "assistant", "New answer"),
            ],
            "thread-a",
            false,
            { hiddenFeedItemCount: 12 },
          ),
        );
      });

      expect(viewport.scrollTop).toBe(1_290);
      expect(
        container.querySelector('[data-message-id="anchor-user"]')?.getBoundingClientRect().top,
      ).toBe(-50);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("shows and clears a visible new-message count while follow-tail is detached", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["assistant-1", 700],
      ["assistant-2", 200],
      ["assistant-3", 200],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const initialItems = [
        message("user-1", "user", "Question"),
        message("assistant-1", "assistant", "Answer"),
      ];

      await act(async () => {
        root.render(renderFeed(initialItems, "thread-a"));
      });
      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewport) throw new Error("missing viewport");
      viewport.scrollTop = 100;
      await act(async () => {
        viewport.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -80 }),
        );
        viewport.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });
      expect(viewport.dataset.scrollMode).toBe("detached");

      await act(async () => {
        root.render(
          renderFeed(
            [
              ...initialItems,
              message("assistant-2", "assistant", "New answer"),
              message("assistant-3", "assistant", "Another answer"),
            ],
            "thread-a",
          ),
        );
      });

      const jumpButton = container.querySelector(
        '[aria-label="2 new messages. Jump to latest"]',
      ) as HTMLButtonElement | null;
      expect(jumpButton).not.toBeNull();
      expect(jumpButton?.textContent).toContain("2 new messages");
      expect(viewport.scrollTop).toBe(100);

      await act(async () => {
        jumpButton?.click();
      });
      expect(container.querySelector('[aria-label="2 new messages. Jump to latest"]')).toBeNull();
      expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("does not restore a stale lower anchor while upward wheel scrolling reveals the jump control", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["assistant-1", 900],
      ["assistant-2", 300],
    ]);
    const harness = setupScroller(heights);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed(
            [
              message("user-1", "user", "Question"),
              message("assistant-1", "assistant", "Long answer"),
              message("assistant-2", "assistant", "Latest answer"),
            ],
            "thread-a",
          ),
        );
      });

      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!viewport) throw new Error("missing viewport");

      await act(async () => {
        viewport.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -120 }),
        );
        // Browser default scrolling happens after the wheel handler but before
        // the scroll event. A resize notification in this gap used to restore
        // the stale lower anchor and produce the visible double jump.
        viewport.scrollTop = 300;
        ControlledResizeObserver.trigger();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(container.querySelector('[aria-label="Jump to latest"]')).not.toBeNull();
      expect(viewport.scrollTop).toBe(300);

      await act(async () => {
        viewport.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });
      expect(viewport.scrollTop).toBe(300);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("keeps a detached viewport and Activity shell stable when a turn completes", async () => {
    const heights = new Map([
      ["user-1", 100],
      ["assistant-1", 700],
      ["activity-tool-1", 180],
    ]);
    const harness = setupScroller(heights);
    const activity: ChatRenderItem = {
      kind: "activity-group",
      id: "activity-tool-1",
      recoveredToolIds: [],
      items: [
        {
          id: "tool-1",
          kind: "tool",
          ts: "2026-06-26T12:00:01.000Z",
          completedAt: "2026-06-26T12:00:02.000Z",
          name: "read",
          state: "output-available",
          result: { ok: true },
        },
      ],
    };
    const items = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Answer"),
      activity,
    ];

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeed(items, "thread-a", false, {
            liveActivityGroupId: "activity-tool-1",
          }),
        );
      });
      const viewport = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      const activityShell = container.querySelector(
        '[data-message-id="activity-tool-1"]',
      )?.firstElementChild;
      if (!viewport) throw new Error("missing viewport");
      viewport.scrollTop = 100;
      await act(async () => {
        viewport.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -80 }),
        );
        viewport.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });

      await act(async () => {
        root.render(renderFeed(items, "thread-a", false, { liveActivityGroupId: null }));
      });

      expect(viewport.scrollTop).toBe(100);
      expect(
        container.querySelector('[data-message-id="activity-tool-1"]')?.firstElementChild,
      ).toBe(activityShell);
      expect(container.textContent).toContain("Worked for");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });
});
