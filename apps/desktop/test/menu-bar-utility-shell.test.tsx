import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
    saveState: async () => {},
    startWorkspaceServer: async () => ({ url: "ws://mock" }),
    stopWorkspaceServer: async () => {},
  }),
);

const { useAppStore } = await import("../src/app/store");
const { MenuBarUtilityShell } = await import("../src/ui/menuBar/MenuBarUtilityShell");

const defaultStoreState = useAppStore.getState();

function resetAppStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    ...defaultStoreState,
    ready: true,
    bootstrapPhase: "ready",
    startupError: null,
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
    threads: [],
    ...overrides,
  } as any);
}

describe("MenuBarUtilityShell", () => {
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupJsdom({ includeAnimationFrame: true });
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

  test("includes ordinary draft chats in recents while excluding task-owned drafts", () => {
    resetAppStore({
      threads: [
        {
          id: "task-draft-1",
          workspaceId: "ws-1",
          title: "Task draft",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T12:00:00.000Z",
          status: "active",
          sessionId: "task-session-1",
          messageCount: 0,
          lastEventSeq: 0,
          draft: true,
          taskId: "task-1",
        },
        {
          id: "draft-chat-1",
          workspaceId: "ws-1",
          title: "Project draft",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T11:00:00.000Z",
          status: "active",
          sessionId: "draft-session-1",
          messageCount: 0,
          lastEventSeq: 0,
          draft: true,
        },
        {
          id: "chat-1",
          workspaceId: "ws-1",
          title: "Existing chat",
          createdAt: "2026-03-24T09:00:00.000Z",
          lastMessageAt: "2026-03-24T10:00:00.000Z",
          status: "active",
          sessionId: "session-1",
          messageCount: 3,
          lastEventSeq: 3,
          draft: false,
        },
      ],
    });

    act(() => {
      root.render(
        createElement(MenuBarUtilityShell, {
          init: async () => {},
          ready: true,
          startupError: null,
        }),
      );
    });

    expect(container.textContent).toContain("Project draft");
    expect(container.textContent).toContain("Existing chat");
    expect(container.textContent).not.toContain("Task draft");
  });

  test("shows truthful recovery actions when startup fails before readiness", () => {
    resetAppStore({
      ready: false,
      bootstrapPhase: "error",
      startupError: "The saved desktop state could not be loaded.",
    });

    act(() => {
      root.render(
        createElement(MenuBarUtilityShell, {
          init: async () => {},
          ready: false,
          startupError: "The saved desktop state could not be loaded.",
        }),
      );
    });

    expect(container.textContent).toContain("Cowork couldn't start");
    expect(container.textContent).toContain("The saved desktop state could not be loaded.");
    expect(container.textContent).toContain("Copy diagnostics");
    expect(container.textContent).not.toContain("Recovered");
  });
});
