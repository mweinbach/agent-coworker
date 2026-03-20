import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

const { useAppStore } = await import("../src/app/store");
const { ContextSidebar } = await import("../src/ui/ContextSidebar");

describe("desktop context sidebar", () => {
  test("renders child-agent summaries for the selected thread", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      useAppStore.setState((state) => ({
        ...state,
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
                lastMessagePreview: "Checking the failing snapshot expectation.",
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
      }) as any);

      await act(async () => {
        root.render(createElement(ContextSidebar));
      });

      const text = container.textContent ?? "";
      expect(text).toContain("AGENTS");
      expect(text).toContain("Investigate parser test");
      expect(text).toContain("worker · depth 1 · gpt-5.4");
      expect(text).toContain("Checking the failing snapshot expectation.");
      expect(text).toContain("busy");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("keeps tasks and agents in scrollable sections so files can keep the remaining height", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      useAppStore.setState((state) => ({
        ...state,
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
      }) as any);

      await act(async () => {
        root.render(createElement(ContextSidebar));
      });

      const tasksSection = container.querySelector('[data-sidebar-section="tasks"]');
      const agentsSection = container.querySelector('[data-sidebar-section="agents"]');
      const scrollCards = Array.from(container.querySelectorAll('[data-slot="card"]')).slice(0, 2);

      expect(tasksSection?.className).toContain("overflow-y-auto");
      expect(tasksSection?.className).toContain("flex-1");
      expect(tasksSection?.className).toContain("overscroll-contain");
      expect(agentsSection?.className).toContain("overflow-y-auto");
      expect(agentsSection?.className).toContain("flex-1");
      expect(agentsSection?.className).toContain("overscroll-contain");
      expect(scrollCards).toHaveLength(2);
      for (const card of scrollCards) {
        expect(card.className).toContain("flex");
        expect(card.className).toContain("flex-col");
        expect(card.className).toContain("max-h-[30%]");
        expect(card.className).toContain("overflow-hidden");
      }

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
