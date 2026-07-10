import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { SessionFeedItem } from "../../../src/shared/sessionSnapshot";
import type { ChatRenderItem } from "../src/ui/chat/activityGroups";
import { ChatViewContext } from "../src/ui/chat/ChatViewContext";
import type { MentionCatalog } from "../src/ui/chat/composerMentions";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { type JsdomHarness, setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());

const { ChatFeed } = await import("../src/ui/chat/ChatFeed");

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
) {
  const { HTMLElement } = harness.dom.window;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
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

function renderFeed(renderItems: ChatRenderItem[], selectedThreadId: string, hydrating = false) {
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
      citationUrlsByMessageId: new Map(),
      citationSourcesByMessageId: new Map(),
      desktopBasePath: null,
      latestRemovedSurfaceItemId: null,
      REMOVEDUIEnabled: false,
      composerOverlayHeight: 200,
      sandboxApprovals: [],
      onAnswerApproval: () => true,
      selectedThreadId,
    }),
  );
}

function setupScroller(heights: Map<string, number>) {
  ControlledResizeObserver.callbacks.clear();
  const harness = setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: { ResizeObserver: ControlledResizeObserver },
  });
  installScrollerGeometry(harness, heights);
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
      expect(container.querySelector('[data-message-id="user-1"]')?.dataset.scrollAnchor).toBe(
        "true",
      );
      expect(container.querySelector('[data-message-id="user-2"]')?.dataset.scrollAnchor).toBe(
        "true",
      );
      expect(container.querySelector('[data-message-id="assistant-2"]')?.dataset.scrollAnchor).toBe(
        "false",
      );
      expect(container.querySelector('[data-slot="message-scroller-button"]')?.style.bottom).toBe(
        "209px",
      );

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
      expect(container.querySelector('[data-message-id="user-2"]')?.dataset.scrollAnchor).toBe(
        "true",
      );

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
        '[aria-label="Scroll to end"]',
      ) as HTMLButtonElement | null;
      expect(scrollToEnd?.dataset.active).toBe("true");
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

      await act(async () => {
        root.render(renderFeed(items, "thread-long"));
      });

      // Soft window keeps the newest 80 entries + show-older control.
      expect(container.querySelector('[data-message-id="msg-0"]')).toBeNull();
      expect(container.querySelector('[data-message-id="msg-19"]')).toBeNull();
      expect(container.querySelector('[data-message-id="msg-20"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="msg-99"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="status:show-older"]')).not.toBeNull();

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
});
