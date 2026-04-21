import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const { useAppStore } = await import("../src/app/store");
const { ContextSidebar } = await import("../src/ui/ContextSidebar");
const { ContextSidebarResizer } = await import("../src/ui/layout/ContextSidebarResizer");

function resetAppStore(overrides: Record<string, unknown>) {
  const state = useAppStore.getState();
  useAppStore.setState({
    ...state,
    ready: true,
    bootstrapPending: false,
    startupError: null,
    view: "chat",
    settingsPage: "providers",
    lastNonSettingsView: "chat",
    workspaces: [],
    threads: [],
    selectedWorkspaceId: null,
    selectedThreadId: null,
    workspaceRuntimeById: {},
    threadRuntimeById: {},
    latestTodosByThreadId: {},
    workspaceExplorerById: {},
    promptModal: null,
    notifications: [],
    providerStatusByName: {},
    providerStatusLastUpdatedAt: null,
    providerStatusRefreshing: false,
    providerCatalog: [],
    providerDefaultModelByProvider: {},
    providerConnected: [],
    providerAuthMethodsByProvider: {},
    providerLastAuthChallenge: null,
    providerLastAuthResult: null,
    composerText: "",
    injectContext: false,
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: false,
    onboardingVisible: false,
    sidebarCollapsed: false,
    contextSidebarCollapsed: false,
    contextSidebarWidth: 300,
    messageBarHeight: 120,
    sidebarWidth: 248,
    ...overrides,
  } as any);
}

describe("desktop context sidebar", () => {
  test.serial("renders subagent summaries for the selected thread", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true, extraGlobals: { ResizeObserver: MockResizeObserver } });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      resetAppStore({
        selectedThreadId: "thread-1",
        selectedWorkspaceId: null,
        latestTodosByThreadId: {},
        threadRuntimeById: {
          "thread-1": {
            wsUrl: null,
            connected: true,
            sessionId: "root-123",
            config: null,
            sessionConfig: null,
            sessionKind: "root",
            parentSessionId: null,
            role: null,
            mode: null,
            depth: 0,
            nickname: null,
            requestedModel: null,
            effectiveModel: null,
            requestedReasoningEffort: null,
            effectiveReasoningEffort: null,
            executionState: null,
            lastMessagePreview: null,
            agents: [
              {
                agentId: "child-456",
                parentSessionId: "root-123",
                role: "worker",
                mode: "collaborative",
                depth: 1,
                effectiveModel: "gpt-5.4",
                title: "Investigate parser test",
                provider: "openai",
                createdAt: "2026-03-15T10:00:00.000Z",
                updatedAt: "2026-03-15T10:05:00.000Z",
                lifecycleState: "active",
                executionState: "running",
                busy: true,
                lastMessagePreview: "**Markdown** _preview_ for the [summary](https://example.com).",
              },
            ],
            sessionUsage: null,
            lastTurnUsage: null,
            enableMcp: true,
            busy: false,
            busySince: null,
            feed: [],
            transcriptOnly: false,
          },
        },
      });

      await act(async () => {
        root.render(createElement(ContextSidebar));
      });

      const text = container.textContent ?? "";
      const subagentsPanel = container.querySelector('[data-sidebar-panel="subagents"]');
      const nestedAgentPanel = container.querySelector(".app-context-sidebar__nested-panel");
      expect(text).toContain("Subagents");
      expect(text).toContain("Investigate parser test");
      expect(text).toContain("worker · depth 1 · gpt-5.4");
      expect(text).toContain("Markdown");
      expect(text).toContain("preview");
      expect(text).toContain("summary");
      expect(text).not.toContain("**Markdown**");
      expect(text).toContain("busy");
      expect(subagentsPanel?.className).toContain("app-context-sidebar__panel");
      expect(nestedAgentPanel?.className).toContain("app-context-sidebar__nested-panel");
      expect(nestedAgentPanel?.querySelector("a")).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("keeps tasks and subagents in scrollable sections so files can keep the remaining height", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true, extraGlobals: { ResizeObserver: MockResizeObserver } });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      resetAppStore({
        selectedThreadId: "thread-1",
        selectedWorkspaceId: null,
        latestTodosByThreadId: {
          "thread-1": Array.from({ length: 8 }, (_, index) => ({
            content: `Todo ${index + 1}`,
            status: index < 2 ? "completed" : index === 2 ? "in_progress" : "pending",
          })),
        },
        threadRuntimeById: {
          "thread-1": {
            wsUrl: null,
            connected: true,
            sessionId: "root-123",
            config: null,
            sessionConfig: null,
            sessionKind: "root",
            parentSessionId: null,
            role: null,
            mode: null,
            depth: 0,
            nickname: null,
            requestedModel: null,
            effectiveModel: null,
            requestedReasoningEffort: null,
            effectiveReasoningEffort: null,
            executionState: null,
            lastMessagePreview: null,
            agents: Array.from({ length: 6 }, (_, index) => ({
              agentId: `child-${index + 1}`,
              parentSessionId: "root-123",
              role: "worker",
              mode: "collaborative",
              depth: 1,
              effectiveModel: "gpt-5.4",
              title: `Investigate item ${index + 1}`,
              provider: "openai",
              createdAt: "2026-03-15T10:00:00.000Z",
              updatedAt: "2026-03-15T10:05:00.000Z",
              lifecycleState: "active",
              executionState: index === 0 ? "running" : "completed",
              busy: index === 0,
              lastMessagePreview: `Preview ${index + 1}`,
            })),
            sessionUsage: null,
            lastTurnUsage: null,
            enableMcp: true,
            busy: false,
            busySince: null,
            feed: [],
            transcriptOnly: false,
          },
        },
      });

      await act(async () => {
        root.render(createElement(ContextSidebar));
      });

      const tasksSection = container.querySelector('[data-sidebar-section="tasks"]');
      const agentsSection = container.querySelector('[data-sidebar-section="subagents"]');
      const tasksPanel = container.querySelector('[data-sidebar-panel="tasks"]');
      const agentsPanel = container.querySelector('[data-sidebar-panel="subagents"]');
      const filesPanel = container.querySelector('[data-sidebar-panel="files"]');

      expect(tasksSection?.className).toContain("overflow-y-auto");
      expect(tasksSection?.className).toContain("max-h-[10.5rem]");
      expect(tasksSection?.className).toContain("overscroll-contain");
      expect(agentsSection?.className).toContain("overflow-y-auto");
      expect(agentsSection?.className).toContain("max-h-[10.5rem]");
      expect(agentsSection?.className).toContain("overscroll-contain");
      expect(tasksPanel?.className).toContain("app-context-sidebar__panel");
      expect(agentsPanel?.className).toContain("app-context-sidebar__panel");
      expect(tasksPanel?.className).toContain("flex-none");
      expect(agentsPanel?.className).toContain("flex-none");
      expect(filesPanel?.className).toContain("app-context-sidebar__panel");
      expect(filesPanel?.className).toContain("flex-1");
      expect(filesPanel?.className).toContain("overflow-hidden");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("keeps the context sidebar resize rail invisible but easy to grab", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true, extraGlobals: { ResizeObserver: MockResizeObserver } });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      resetAppStore({
        contextSidebarWidth: 300,
      });

      await act(async () => {
        root.render(createElement(ContextSidebarResizer));
      });

      const separator = container.querySelector('[aria-label="Resize context sidebar"]');

      expect(separator).not.toBeNull();
      expect(separator?.className).toContain("app-native-no-drag");
      expect(separator?.className).toContain("-left-1");
      expect(separator?.className).toContain("w-3");
      expect(separator?.className).not.toContain("bg-primary/20");
      expect(separator?.getAttribute("aria-valuenow")).toBe("300");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
