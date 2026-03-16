import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { useAppStore } = await import("../src/app/store");
const { ContextSidebar } = await import("../src/ui/ContextSidebar");

function setupJsdom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost",
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    getComputedStyle: globalThis.getComputedStyle,
    actEnv: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return {
    dom,
    restore: () => {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.navigator = saved.navigator;
      globalThis.HTMLElement = saved.HTMLElement;
      globalThis.Node = saved.Node;
      globalThis.getComputedStyle = saved.getComputedStyle;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.actEnv;
      dom.window.close();
    },
  };
}

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
});
