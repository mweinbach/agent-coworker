import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Mock desktopCommands before importing the store (which reads feature flags
// from it during initialization). Reuse the shared helper so every export the
// store touches at import time is satisfied.
mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
    saveState: async () => {},
    startWorkspaceServer: async () => ({ url: "ws://mock" }),
    stopWorkspaceServer: async () => {},
    confirmAction: async () => true,
    showContextMenu: async () => null,
  }),
);

const { useAppStore } = await import("../src/app/store");
const { CommandPalette } = await import("../src/ui/CommandPalette");

const defaultStoreState = useAppStore.getState();

function resetAppStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    ...defaultStoreState,
    ready: true,
    bootstrapPending: false,
    startupError: null,
    view: "chat",
    workspaces: [],
    threads: [],
    selectedWorkspaceId: null,
    selectedThreadId: null,
    workspaceRuntimeById: {},
    threadRuntimeById: {},
    developerMode: false,
    desktopFeatureFlags: {
      menuBar: true,
      remoteAccess: true,
      workspacePicker: true,
      workspaceLifecycle: true,
      a2ui: false,
    },
    selectThread: mock(() => Promise.resolve()),
    selectWorkspace: mock(() => Promise.resolve()),
    openSettings: mock(() => {}),
    openSkills: mock(() => Promise.resolve()),
    openNewChatLanding: mock(() => Promise.resolve()),
    ...overrides,
  } as any);
}

function setupPaletteJsdom() {
  const harness = setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: { ResizeObserver: MockResizeObserver },
  });
  // cmdk calls scrollIntoView on the selected item; jsdom doesn't implement it.
  harness.dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return harness;
}

describe("CommandPalette", () => {
  let harness: ReturnType<typeof setupPaletteJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupPaletteJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    useAppStore.setState(defaultStoreState);
    harness.restore();
  });

  test("renders recent threads and workspaces when open", () => {
    resetAppStore({
      threads: [
        {
          id: "t-1",
          workspaceId: "ws-1",
          title: "Refactor plan",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T10:00:00.000Z",
          status: "active",
          sessionId: "s-1",
          messageCount: 3,
          lastEventSeq: 3,
        },
      ],
      workspaces: [
        {
          id: "ws-1",
          name: "Agent Coworker",
          path: "/tmp/agent-coworker",
          workspaceKind: "project",
          createdAt: "2026-03-24T00:00:00.000Z",
          lastOpenedAt: "2026-03-24T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
    });
    act(() => {
      root.render(
        createElement(CommandPalette, { open: true, onOpenChange: () => {} }),
      );
    });
    const body = harness.dom.window.document.body;
    const items = Array.from(body.querySelectorAll("[data-slot='command-item']")).map((n) =>
      n.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(items.some((t) => t?.includes("Refactor plan"))).toBe(true);
    expect(items.some((t) => t?.includes("Agent Coworker"))).toBe(true);
    // New chat + Browse skills actions always present.
    expect(items.some((t) => t?.includes("New chat"))).toBe(true);
    expect(items.some((t) => t?.includes("Browse skills"))).toBe(true);
  });

  test("excludes draft and archived threads from recent", () => {
    resetAppStore({
      threads: [
        {
          id: "t-live",
          workspaceId: "ws-1",
          title: "Live thread",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T10:00:00.000Z",
          status: "active",
          sessionId: "s-1",
          messageCount: 1,
          lastEventSeq: 1,
        },
        {
          id: "t-draft",
          workspaceId: "ws-1",
          title: "Draft thread",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T11:00:00.000Z",
          status: "active",
          sessionId: "s-2",
          messageCount: 0,
          lastEventSeq: 0,
          draft: true,
        },
        {
          id: "t-archived",
          workspaceId: "ws-1",
          title: "Archived thread",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T12:00:00.000Z",
          status: "active",
          sessionId: "s-3",
          messageCount: 5,
          lastEventSeq: 5,
          archived: true,
        },
      ],
      workspaces: [],
    });
    act(() => {
      root.render(
        createElement(CommandPalette, { open: true, onOpenChange: () => {} }),
      );
    });
    const body = harness.dom.window.document.body;
    const items = Array.from(body.querySelectorAll("[data-slot='command-item']")).map((n) =>
      n.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(items.some((t) => t?.includes("Live thread"))).toBe(true);
    expect(items.some((t) => t?.includes("Draft thread"))).toBe(false);
    expect(items.some((t) => t?.includes("Archived thread"))).toBe(false);
  });

  test("lists settings pages derived from getSettingsGroups", () => {
    resetAppStore({ workspaces: [], threads: [] });
    act(() => {
      root.render(
        createElement(CommandPalette, { open: true, onOpenChange: () => {} }),
      );
    });
    const body = harness.dom.window.document.body;
    const items = Array.from(body.querySelectorAll("[data-slot='command-item']")).map((n) =>
      n.textContent?.replace(/\s+/g, " ").trim(),
    );
    // Models is the first page in the default "Models & tools" group.
    expect(items.some((t) => t === "Models")).toBe(true);
  });

  test("closing the palette does not crash", () => {
    resetAppStore({});
    act(() => {
      root.render(
        createElement(CommandPalette, { open: false, onOpenChange: () => {} }),
      );
    });
    const body = harness.dom.window.document.body;
    // When closed, no command input should be present.
    expect(body.querySelector("[data-slot='command-input']")).toBeFalsy();
  });
});
