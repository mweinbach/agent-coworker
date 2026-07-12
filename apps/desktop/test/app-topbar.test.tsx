import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ThreadAgentSummary } from "../src/app/types";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());

const { AppTopBar } = await import("../src/ui/layout/AppTopBar");
const { OverlayStackProvider } = await import("../src/ui/OverlayStack");

const sessionUsage = {
  sessionId: "session-1",
  totalTurns: 3,
  totalPromptTokens: 900,
  totalCompletionTokens: 300,
  totalCachedPromptTokens: 200,
  totalCacheWritePromptTokens: 100,
  totalTokens: 1200,
  estimatedTotalCostUsd: 0.0245,
  costBreakdown: {
    inputCostUsd: 0.001,
    cachedInputCostUsd: 0.0001,
    cacheWriteInputCostUsd: 0.0002,
    outputCostUsd: 0.0232,
    otherCostUsd: 0,
  },
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

const legacySessionUsage = {
  sessionId: "legacy-session",
  totalTurns: 3,
  totalPromptTokens: 3_442_232,
  totalCompletionTokens: 45_513,
  totalCachedPromptTokens: 1_497_866,
  totalTokens: 2_023_803,
  totalReasoningOutputTokens: 33_924,
  estimatedTotalCostUsd: 3.5508459,
  costTrackingAvailable: true,
  byModel: [
    {
      provider: "google" as const,
      model: "gemini-3.5-flash",
      turns: 3,
      totalPromptTokens: 3_442_232,
      totalCompletionTokens: 45_513,
      totalCachedPromptTokens: 1_497_866,
      totalTokens: 2_023_803,
      totalReasoningOutputTokens: 33_924,
      estimatedCostUsd: 3.5508459,
    },
  ],
  turns: [
    {
      turnId: "turn-1",
      turnIndex: 1,
      timestamp: "2026-05-29T13:00:26.616Z",
      provider: "google" as const,
      model: "gemini-3.5-flash",
      usage: {
        promptTokens: 3_442_232,
        completionTokens: 45_513,
        cachedPromptTokens: 1_497_866,
        reasoningOutputTokens: 33_924,
        totalTokens: 2_023_803,
      },
      estimatedCostUsd: 3.5508459,
      pricing: {
        inputPerMillion: 1.5,
        cachedInputPerMillion: 0.15,
        outputPerMillion: 9,
      },
    },
  ],
  budgetStatus: {
    configured: false,
    warnAtUsd: null,
    stopAtUsd: null,
    warningTriggered: false,
    stopTriggered: false,
    currentCostUsd: 3.5508459,
  },
  createdAt: "2026-05-29T12:31:40.910Z",
  updatedAt: "2026-05-29T13:00:26.616Z",
};

const subagentUsage = {
  sessionId: "agent-1",
  totalTurns: 2,
  totalPromptTokens: 600,
  totalCompletionTokens: 400,
  totalCachedPromptTokens: 50,
  totalTokens: 1000,
  estimatedTotalCostUsd: 0.01,
  costBreakdown: {
    inputCostUsd: 0.002,
    cachedInputCostUsd: 0.0005,
    cacheWriteInputCostUsd: 0,
    outputCostUsd: 0.0075,
    otherCostUsd: 0,
  },
  costTrackingAvailable: true,
  byModel: [],
  turns: [],
  budgetStatus: {
    configured: false,
    warnAtUsd: null,
    stopAtUsd: null,
    warningTriggered: false,
    stopTriggered: false,
    currentCostUsd: 0.01,
  },
  createdAt: "2026-03-24T16:02:00.000Z",
  updatedAt: "2026-03-24T16:04:00.000Z",
};

const agents: ThreadAgentSummary[] = [
  {
    agentId: "agent-1",
    parentSessionId: "session-1",
    role: "research",
    mode: "collaborative",
    depth: 1,
    effectiveModel: "gpt-5-mini",
    title: "Research agent",
    provider: "openai",
    createdAt: "2026-03-24T16:02:00.000Z",
    updatedAt: "2026-03-24T16:04:00.000Z",
    lifecycleState: "active",
    executionState: "completed",
    busy: false,
    sessionUsage: subagentUsage,
    lastTurnUsage: {
      promptTokens: 600,
      cachedPromptTokens: 50,
      completionTokens: 400,
      totalTokens: 1000,
      estimatedCostUsd: 0.01,
    },
  },
];

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
            agents,
          }),
        );
      });

      const strip = container.querySelector(".app-topbar");
      const sidebarFill = container.querySelector(".app-topbar__sidebar-fill");
      const titleShell = container.querySelector(".app-topbar__thread-shell");
      const titleButton = container.querySelector('button[aria-label="Open thread details"]');
      const sidebarToggle = container.querySelector('button[aria-label="Hide sidebar"]');
      const contextToggle = container.querySelector('button[aria-label="Hide context"]');
      const inlineSidebarToggle = container.querySelector(".app-topbar__inline-sidebar-toggle");
      const rightToolbar = container.querySelector(".app-topbar__toolbar--right");
      const newChatButton = container.querySelector('button[aria-label="New Chat"]');
      const newChatReveal = newChatButton?.closest(".app-topbar__new-chat-reveal");

      expect(strip).not.toBeNull();
      expect(strip?.className).not.toContain("overflow-hidden");
      expect(sidebarFill).not.toBeNull();
      expect(sidebarFill?.className).toContain("border-r");
      expect(sidebarFill?.className).toContain("border-border/70");
      expect(sidebarToggle).not.toBeNull();
      expect(sidebarToggle?.className).toContain("app-topbar__plain-icon-button");
      expect(inlineSidebarToggle?.className).toContain("app-topbar__toolbar-layer");
      expect(inlineSidebarToggle?.className).not.toContain("app-topbar__toolbar ");
      expect(inlineSidebarToggle?.className).not.toContain(
        "app-topbar__toolbar app-topbar__controls",
      );
      expect(newChatButton).toBeNull();
      expect(newChatReveal).toBeUndefined();
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
      expect(rightToolbar?.className).toContain("app-topbar__toolbar-layer");
      expect(rightToolbar?.className).toContain("inset-y-0");
      expect(rightToolbar?.className).not.toContain("app-topbar__toolbar ");
      expect(container.textContent).toContain("Busy");

      await act(async () => {
        titleButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).toContain("Usage");
      expect(container.textContent).toContain("Estimated cost");
      expect(container.textContent).toContain("$0.03");
      expect(container.textContent).toContain("2.2k");
      expect(container.textContent).toContain("Original input");
      expect(container.textContent).not.toContain("Cache-read input");
      expect(container.textContent).toContain("Last turn cost");

      const moreButton = container.querySelector('button[aria-label="Show usage details"]');
      expect(moreButton).not.toBeNull();
      await act(async () => {
        moreButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).toContain("Parent cost");
      expect(container.textContent).toContain("Subagent cost");
      expect(container.textContent).toContain("Standard-rate input");
      expect(container.textContent).toContain("Cache-read input");
      expect(container.textContent).toContain("Cache-write input");
      expect(container.textContent).toContain("Standard-rate spend");
      expect(container.textContent).toContain("Output spend");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("maps legacy usage estimates into token spend buckets", async () => {
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
            title: "Tesla Robotics and Self-Driving Synergy",
            subtitle: null,
            sessionUsage: legacySessionUsage,
            lastTurnUsage: null,
          }),
        );
      });

      const titleButton = container.querySelector('button[aria-label="Open thread details"]');
      expect(titleButton).not.toBeNull();
      await act(async () => {
        titleButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const moreButton = container.querySelector('button[aria-label="Show usage details"]');
      expect(moreButton).not.toBeNull();
      await act(async () => {
        moreButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).toContain("Original input");
      expect(container.textContent).toContain("1.94M");
      expect(container.textContent).toContain("Cache-read input");
      expect(container.textContent).toContain("1.50M");
      expect(container.textContent).toContain("Standard-rate spend");
      expect(container.textContent).toContain("$2.92");
      expect(container.textContent).toContain("Cache-read spend");
      expect(container.textContent).toContain("$0.22");
      expect(container.textContent).toContain("Output spend");
      expect(container.textContent).toContain("$0.41");
      expect(container.textContent).not.toContain("Other estimated spend");

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

  test("keeps the win32 topbar sidebar strip mounted when the sidebar is expanded", async () => {
    const harness = setupJsdom();

    try {
      harness.dom.window.document.documentElement.dataset.platform = "win32";
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
            title: "Refine desktop app UI",
            subtitle: "agent-coworker",
            sessionUsage: null,
            lastTurnUsage: null,
          }),
        );
      });

      expect(container.querySelector(".app-sidebar-collapse-control")).toBeNull();
      expect(container.querySelector(".app-topbar__win32-left-rail")).not.toBeNull();
      expect(container.querySelector(".app-topbar__sidebar-strip")).not.toBeNull();
      expect(container.querySelector(".app-topbar__inline-sidebar-toggle")).toBeNull();
      expect(container.querySelector('button[aria-label="New Chat"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Hide sidebar"]')).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("shows expand + new chat strip on win32 when sidebar is collapsed", async () => {
    const harness = setupJsdom();

    try {
      harness.dom.window.document.documentElement.dataset.platform = "win32";
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: false,
            onToggleSidebar: () => {},
            onNewChat: () => {},
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

      const leftRail = container.querySelector(".app-topbar__win32-left-rail");
      const strip = container.querySelector(".app-topbar__sidebar-strip");
      const titleShell = container.querySelector(".app-topbar__thread-shell");
      const buttons = Array.from(strip?.querySelectorAll("button") ?? []);

      expect(container.querySelector(".app-sidebar-collapse-control")).toBeNull();
      expect(leftRail).not.toBeNull();
      expect(strip).not.toBeNull();
      expect(strip?.className).toContain("app-topbar__toolbar-layer");
      expect(buttons).toHaveLength(2);
      expect(buttons[0]?.getAttribute("aria-label")).toBe("Show sidebar");
      expect(buttons[1]?.getAttribute("aria-label")).toBe("New Chat");
      expect(titleShell?.getAttribute("style")).toContain("left: 84px");
      const contentFill = container.querySelector(
        ".app-topbar__content-fill",
      ) as HTMLElement | null;
      expect(contentFill?.getAttribute("style")).toContain("left: 84px");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("aligns Linux right toolbar controls next to native window buttons", async () => {
    const harness = setupJsdom();

    try {
      harness.dom.window.document.documentElement.dataset.platform = "linux";
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
            onPopOutQuickChat: () => {},
            title: "Refine desktop app UI",
            subtitle: "agent-coworker",
            sessionUsage: null,
            lastTurnUsage: null,
          }),
        );
      });

      const rightToolbar = container.querySelector(".app-topbar__toolbar--right") as HTMLElement;
      const titleShell = container.querySelector(".app-topbar__thread-shell");

      expect(container.querySelector(".app-topbar__win32-left-rail")).not.toBeNull();
      expect(rightToolbar).not.toBeNull();
      expect(rightToolbar.style.right).toBe("154px");
      expect(titleShell?.getAttribute("style")).toContain("right: 186px");

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
            suppressThreadDetails: true,
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

  test("renders Research as non-interactive title chrome", async () => {
    const harness = setupJsdom();

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
            onNewChat: () => {},
            sidebarCollapsed: false,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
            title: "Research",
            subtitle: null,
            sessionUsage: null,
            lastTurnUsage: null,
            showContextToggle: false,
            suppressThreadDetails: true,
          }),
        );
      });

      const titleShell = container.querySelector(".app-topbar__thread-shell");
      const researchTitle = container.querySelector(".app-topbar__thread-title");

      expect(titleShell?.getAttribute("style")).toContain("left: 280px");
      expect(researchTitle?.textContent).toBe("Research");
      expect(container.querySelector('button[aria-label="Open thread details"]')).toBeNull();
      expect(container.querySelector(".app-sidebar-collapse-control")).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("keeps thread details available for chat threads titled Research", async () => {
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
            title: "Research",
            subtitle: "agent-coworker",
            sessionUsage,
            lastTurnUsage: null,
            suppressThreadDetails: false,
          }),
        );
      });

      const titleButton = container.querySelector('button[aria-label="Open thread details"]');

      expect(titleButton).not.toBeNull();
      expect(titleButton?.textContent).toContain("Research");
      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("opens quick chat from the active chat top bar", async () => {
    const harness = setupJsdom();
    const onPopOutQuickChat = mock(() => {});

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
            onPopOutQuickChat,
            title: "Refine desktop app UI",
            subtitle: "agent-coworker",
            sessionUsage: null,
            lastTurnUsage: null,
          }),
        );
      });

      const popOutButton = container.querySelector('button[aria-label="Open quick chat"]');
      if (!(popOutButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing quick chat pop-out button");
      }

      await act(async () => {
        popOutButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(onPopOutQuickChat).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("toggles canvas maximize from the canvas top bar", async () => {
    const harness = setupJsdom();
    const onToggleCanvasMaximized = mock(() => {});

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
            title: "Workbook",
            subtitle: "agent-coworker",
            sessionUsage: null,
            lastTurnUsage: null,
            canvasMode: true,
            canvasMaximized: false,
            onToggleCanvasMaximized,
          }),
        );
      });

      const maximizeButton = container.querySelector('button[aria-label="Maximize canvas"]');
      if (!(maximizeButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing canvas maximize button");
      }

      await act(async () => {
        maximizeButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(onToggleCanvasMaximized).toHaveBeenCalledTimes(1);

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
            title: "Workbook",
            subtitle: "agent-coworker",
            sessionUsage: null,
            lastTurnUsage: null,
            canvasMode: true,
            canvasMaximized: true,
            onToggleCanvasMaximized,
          }),
        );
      });

      expect(container.querySelector('button[aria-label="Restore canvas"]')).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("keeps the context and close controls visible while compacting secondary Canvas actions", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: false,
            compactToolbar: true,
            onToggleSidebar: () => {},
            onNewChat: () => {},
            sidebarCollapsed: true,
            sidebarWidth: 0,
            sidebarToggleLabel: "Show sidebar",
            contextSidebarCollapsed: false,
            contextSidebarToggleLabel: "Close context",
            onToggleContextSidebar: () => {},
            title: "Workbook",
            subtitle: null,
            sessionUsage: null,
            lastTurnUsage: null,
            showContextToggle: true,
            canvasMode: true,
            canvasMaximized: false,
            onToggleCanvasMaximized: () => {},
            onPopOutCanvas: () => {},
            onCloseCanvas: () => {},
          }),
        );
      });

      expect(container.querySelector('button[aria-label="Close context"]')).not.toBeNull();
      expect(container.querySelector('button[aria-label="Close canvas"]')).not.toBeNull();
      expect(container.querySelector('button[aria-label="Canvas view options"]')).not.toBeNull();
      expect(container.querySelector('button[aria-label="Open canvas in window"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Maximize canvas"]')).toBeNull();
      expect(
        (container.querySelector(".app-topbar__thread-shell") as HTMLElement | null)?.style.right,
      ).toBe("176px");

      await act(async () => root.unmount());
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
          createElement(
            OverlayStackProvider,
            null,
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
          ),
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
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await Promise.resolve();
        await new Promise<void>((resolve) =>
          harness.dom.window.requestAnimationFrame(() => resolve()),
        );
      });

      expect(windowEscapeCount).toBe(0);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(titleButton);

      harness.dom.window.removeEventListener("keydown", handleWindowKeyDown);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
