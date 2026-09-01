import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { TaskSummary } from "../src/app/types";
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
    bootstrapPhase: "ready",
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
      REMOVEDUI: false,
    },
    selectThread: mock(() => Promise.resolve()),
    selectWorkspace: mock(() => Promise.resolve()),
    selectTask: mock(() => Promise.resolve()),
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

function makeWorkspace(index: number) {
  return {
    id: `ws-${index}`,
    name: `Workspace ${index}`,
    path: `/tmp/workspace-${index}`,
    workspaceKind: "project" as const,
    createdAt: "2026-03-24T00:00:00.000Z",
    lastOpenedAt: "2026-03-24T00:00:00.000Z",
    defaultEnableMcp: true,
    defaultBackupsEnabled: true,
    yolo: false,
  };
}

function makeThread(index: number) {
  const timestamp = `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`;
  return {
    id: `thread-${index}`,
    workspaceId: `ws-${index}`,
    title: `Chat ${index}`,
    createdAt: timestamp,
    lastMessageAt: timestamp,
    status: "active" as const,
    sessionId: `session-${index}`,
    messageCount: 1,
    lastEventSeq: 1,
  };
}

function makeTask(index: number): TaskSummary {
  const timestamp = `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`;
  return {
    id: `task-${index}`,
    workspacePath: "/tmp/workspace-0",
    title: `Task ${index}`,
    objective: "Complete the task",
    status: "draft",
    revision: 0,
    reviewRequired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    threadCount: 1,
    completedWorkItemCount: 0,
    totalWorkItemCount: 1,
    activeBlockerCount: 0,
    pendingQuestionCount: 0,
    blockingQuestionCount: 0,
  };
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

  async function search(value: string) {
    const input = harness.dom.window.document.querySelector<HTMLInputElement>(
      "[data-slot='command-input']",
    );
    if (!input) throw new Error("missing command input");
    await act(async () => {
      input.focus();
      const setValue = Object.getOwnPropertyDescriptor(
        harness.dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!setValue) throw new Error("missing input value setter");
      setValue.call(input, value);
      input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new harness.dom.window.KeyboardEvent("keyup", { bubbles: true }));
    });
    return input;
  }

  test("finds older chats and projects outside the initial recent lists", async () => {
    const workspaces = Array.from({ length: 12 }, (_, index) => makeWorkspace(index));
    workspaces[11] = { ...workspaces[11]!, name: "Migration archive project" };
    const threads = Array.from({ length: 12 }, (_, index) => makeThread(index));
    threads[0] = { ...threads[0]!, title: "Migration archive chat" };
    resetAppStore({ threads, workspaces });
    await act(async () => {
      root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} }));
    });

    await search("Migration archive");

    const body = harness.dom.window.document.body;
    expect(body.textContent).toContain("Migration archive chat");
    expect(body.textContent).toContain("Migration archive project");
    expect(body.textContent).not.toContain("Workspace 1");
  });

  test("selects duplicate chat titles independently with the keyboard", async () => {
    const selectThread = mock(async (_threadId: string) => {});
    resetAppStore({
      workspaces: [makeWorkspace(0), makeWorkspace(1)],
      threads: [
        { ...makeThread(0), title: "Repeated chat title" },
        { ...makeThread(1), title: "Repeated chat title" },
      ],
      selectThread,
    });
    await act(async () => {
      root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} }));
    });
    const input = await search("Repeated chat title");
    await act(async () => {
      input.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });
    await act(async () => {
      input.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(selectThread).toHaveBeenCalledWith("thread-0");
    expect(
      harness.dom.window.document.querySelectorAll(
        "[data-slot='command-item'][aria-selected='true']",
      ),
    ).toHaveLength(1);
  });

  test("searches every enabled task and selects it without opening its internal chat", async () => {
    const tasks = Array.from({ length: 12 }, (_, index) => makeTask(index));
    tasks[0] = { ...tasks[0]!, title: "Older launch checklist" };
    const selectTask = mock(async (_taskId: string) => {});
    const selectThread = mock(async (_threadId: string) => {});
    resetAppStore({
      workspaces: [makeWorkspace(0)],
      taskSummariesByWorkspaceId: { "ws-0": tasks },
      desktopFeatureFlags: { ...defaultStoreState.desktopFeatureFlags, tasks: true },
      selectTask,
      selectThread,
    });
    await act(async () => {
      root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} }));
    });
    const input = await search("Older launch checklist");
    expect(harness.dom.window.document.body.textContent).toContain("Older launch checklist");
    await act(async () => {
      input.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(selectTask).toHaveBeenCalledWith("task-0");
    expect(selectThread).not.toHaveBeenCalled();
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
      root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} }));
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
      root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} }));
    });
    const body = harness.dom.window.document.body;
    const items = Array.from(body.querySelectorAll("[data-slot='command-item']")).map((n) =>
      n.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(items.some((t) => t?.includes("Live thread"))).toBe(true);
    expect(items.some((t) => t?.includes("Draft thread"))).toBe(false);
    expect(items.some((t) => t?.includes("Archived thread"))).toBe(false);
  });

  test("excludes task-owned threads from recent chat commands", () => {
    resetAppStore({
      threads: [
        {
          id: "task-session-1",
          workspaceId: "ws-1",
          title: "Hidden task transcript",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T11:00:00.000Z",
          status: "active",
          sessionId: "task-session-1",
          messageCount: 2,
          lastEventSeq: 2,
          taskId: "task-1",
          taskThreadId: "task-thread-1",
        },
        {
          id: "chat-thread-1",
          workspaceId: "ws-1",
          title: "Visible chat transcript",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T10:00:00.000Z",
          status: "active",
          sessionId: "chat-session-1",
          messageCount: 1,
          lastEventSeq: 1,
        },
      ],
      workspaces: [],
    });
    act(() => {
      root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} }));
    });
    const body = harness.dom.window.document.body;
    const items = Array.from(body.querySelectorAll("[data-slot='command-item']")).map((n) =>
      n.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(items.some((t) => t?.includes("Visible chat transcript"))).toBe(true);
    expect(items.some((t) => t?.includes("Hidden task transcript"))).toBe(false);
  });

  test("lists settings pages derived from getSettingsGroups", () => {
    resetAppStore({ workspaces: [], threads: [] });
    act(() => {
      root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} }));
    });
    const body = harness.dom.window.document.body;
    const items = Array.from(body.querySelectorAll("[data-slot='command-item']")).map((n) =>
      n.textContent?.replace(/\s+/g, " ").trim(),
    );
    // Models is the first page in the default "Models & tools" group.
    expect(items.some((t) => t?.includes("Models"))).toBe(true);
  });

  test("closing the palette does not crash", () => {
    resetAppStore({});
    act(() => {
      root.render(createElement(CommandPalette, { open: false, onOpenChange: () => {} }));
    });
    const body = harness.dom.window.document.body;
    // When closed, no command input should be present.
    expect(body.querySelector("[data-slot='command-input']")).toBeFalsy();
  });
});
