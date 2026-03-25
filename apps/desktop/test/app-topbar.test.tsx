import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

const { AppTopBar } = await import("../src/ui/layout/AppTopBar");

const sessionUsage = {
  sessionId: "session-1",
  totalTurns: 3,
  totalPromptTokens: 900,
  totalCompletionTokens: 300,
  totalTokens: 1200,
  estimatedTotalCostUsd: 0.0245,
  costTrackingAvailable: true,
  byModel: [],
  turns: [],
  budgetStatus: {
    configured: false,
    warnAtUsd: null,
    stopAtUsd: null,
    warningTriggered: false,
    stopTriggered: false,
    currentCostUsd: 0.0245,
  },
  createdAt: "2026-03-24T16:00:00.000Z",
  updatedAt: "2026-03-24T16:05:00.000Z",
};

const lastTurnUsage = {
  turnId: "turn-1",
  usage: {
    promptTokens: 150,
    completionTokens: 50,
    totalTokens: 200,
    estimatedCostUsd: 0.0032,
  },
};

describe("desktop app top bar", () => {
  test("renders a left-aligned thread title and opens usage details from it", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: true,
            onToggleSidebar: () => {},
            onNewChat: () => {},
            sidebarCollapsed: false,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
            title: "Refine desktop app UI",
            subtitle: "agent-coworker",
            sessionUsage,
            lastTurnUsage,
          }),
        );
      });

      const strip = container.querySelector(".app-topbar");
      const sidebarFill = container.querySelector(".app-topbar__sidebar-fill");
      const titleShell = container.querySelector(".app-topbar__thread-shell");
      const titleButton = container.querySelector('button[aria-label="Open thread details"]');
      const sidebarToggle = container.querySelector('button[aria-label="Hide sidebar"]');
      const contextToggle = container.querySelector('button[aria-label="Hide context"]');
      const newChatButton = container.querySelector('button[aria-label="New Chat"]');
      const newChatReveal = newChatButton?.closest(".app-topbar__new-chat-reveal");

      expect(strip).not.toBeNull();
      expect(strip?.className).not.toContain("overflow-hidden");
      expect(sidebarFill).not.toBeNull();
      expect(sidebarFill?.className).toContain("border-r");
      expect(sidebarFill?.className).toContain("border-border/70");
      expect(sidebarToggle).not.toBeNull();
      expect(sidebarToggle?.className).toContain("app-topbar__plain-icon-button");
      expect(newChatButton).not.toBeNull();
      expect(newChatReveal?.getAttribute("aria-hidden")).toBe("true");
      expect(newChatReveal?.className).toContain("max-w-0");
      expect(newChatReveal?.className).toContain("opacity-0");
      expect(titleShell).not.toBeNull();
      expect(titleShell?.getAttribute("style")).toContain("left: 280px");
      expect(titleShell?.className).not.toContain("app-topbar__controls");
      expect(titleButton).not.toBeNull();
      expect(titleButton?.className).toContain("app-topbar__controls");
      expect(container.textContent).toContain("Refine desktop app UI");
      expect(container.textContent).toContain("|");
      expect(container.textContent).toContain("agent-coworker");
      expect(contextToggle).not.toBeNull();
      expect(contextToggle?.className).toContain("app-topbar__toolbar-button");
      expect(contextToggle?.className).toContain("app-topbar__plain-icon-button");
      expect(contextToggle?.closest(".app-topbar__toolbar--right")?.className).toContain("inset-y-0");
      expect(container.textContent).toContain("Busy");

      await act(async () => {
        titleButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).toContain("Usage");
      expect(container.textContent).toContain("Estimated cost");
      expect(container.textContent).toContain("$0.02");
      expect(container.textContent).toContain("1.2k");
      expect(container.textContent).toContain("Last turn cost");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("shows a collapsed new chat icon beside the sidebar toggle", async () => {
    const harness = setupJsdom();
    const onNewChat = mock(() => {});

    try {
      harness.dom.window.document.documentElement.dataset.platform = "darwin";
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: false,
            onToggleSidebar: () => {},
            onNewChat,
            sidebarCollapsed: true,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
            title: "New thread",
            subtitle: "agent-coworker",
            sessionUsage: null,
            lastTurnUsage: null,
          }),
        );
      });

      const sidebarToggle = container.querySelector('button[aria-label="Show sidebar"]');
      const newChatButton = container.querySelector('button[aria-label="New Chat"]');
      const newChatReveal = newChatButton?.closest(".app-topbar__new-chat-reveal");
      const threadAnchor = container.querySelector(".app-topbar__thread-anchor");

      expect(sidebarToggle).not.toBeNull();
      expect(newChatButton).not.toBeNull();
      expect(newChatButton?.className).toContain("app-topbar__toolbar-button");
      expect(newChatButton?.className).toContain("app-topbar__plain-icon-button");
      expect(newChatReveal?.getAttribute("aria-hidden")).toBe("false");
      expect(newChatReveal?.className).toContain("max-w-7");
      expect(newChatReveal?.className).toContain("opacity-100");
      expect(threadAnchor?.className).toContain("app-topbar__thread-anchor--collapsed");
      expect(threadAnchor?.getAttribute("style")).toContain("padding-left: 10rem");

      await act(async () => {
        newChatButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(onNewChat).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("can hide the context sidebar control when a view has no right rail", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: false,
            onToggleSidebar: () => {},
            onNewChat: () => {},
            sidebarCollapsed: false,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
            title: "Skills",
            subtitle: "Cowork Test",
            sessionUsage: null,
            lastTurnUsage: null,
            showContextToggle: false,
          }),
        );
      });

      expect(container.querySelector('button[aria-label="Hide context"]')).toBeNull();
      expect(container.querySelector(".app-topbar__toolbar--right")).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("consumes Escape while the thread details popover is open", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      let windowEscapeCount = 0;
      const handleWindowKeyDown = () => {
        windowEscapeCount += 1;
      };
      harness.dom.window.addEventListener("keydown", handleWindowKeyDown);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: true,
            onToggleSidebar: () => {},
            onNewChat: () => {},
            sidebarCollapsed: false,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
            title: "Refine desktop app UI",
            subtitle: "agent-coworker",
            sessionUsage,
            lastTurnUsage,
          }),
        );
      });

      const titleButton = container.querySelector('button[aria-label="Open thread details"]');
      if (!(titleButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing thread details button");
      }

      await act(async () => {
        titleButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(container.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });

      expect(windowEscapeCount).toBe(0);
      expect(container.querySelector('[role="dialog"]')).toBeNull();

      harness.dom.window.removeEventListener("keydown", handleWindowKeyDown);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
