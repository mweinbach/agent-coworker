import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MockMutationObserver {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const requestAnimationFrameMock = (callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;
const cancelAnimationFrameMock = (id: number) => clearTimeout(id);

const { useAppStore } = await import("../src/app/store");
const { AgentRunViewer } = await import("../src/ui/AgentRunViewer");
const { OverlayStackProvider } = await import("../src/ui/OverlayStack");
const { formatAgentRunFeedForViewer, formatAgentRunMessageText } = await import(
  "../src/ui/chat/agentRunTranscript"
);

const defaultStoreState = useAppStore.getState();

const PARENT_THREAD_ID = "parent-1";
const AGENT_ID = "child-456";

function parentThreadRecord() {
  return {
    id: PARENT_THREAD_ID,
    workspaceId: "ws-1",
    sessionKind: "root",
    title: "Parent chat",
    titleSource: "manual",
    createdAt: "2026-03-15T10:00:00.000Z",
    lastMessageAt: "2026-03-15T10:05:00.000Z",
    status: "active",
    sessionId: "root-123",
    messageCount: 4,
    lastEventSeq: 4,
    draft: false,
    archived: false,
  };
}

function parentAgentSummary(overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID,
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
    ...overrides,
  };
}

function agentThreadRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    workspaceId: "ws-1",
    sessionKind: "agent",
    parentSessionId: "root-123",
    title: "Investigate parser test",
    titleSource: "manual",
    createdAt: "2026-03-15T10:00:00.000Z",
    lastMessageAt: "2026-03-15T10:05:00.000Z",
    status: "active",
    sessionId: AGENT_ID,
    messageCount: 2,
    lastEventSeq: 2,
    draft: false,
    archived: false,
    ...overrides,
  };
}

function agentRuntime(overrides: Record<string, unknown> = {}) {
  return {
    wsUrl: "ws://mock",
    connected: true,
    sessionId: AGENT_ID,
    lastEventSeq: 2,
    config: null,
    sessionConfig: null,
    sessionKind: "agent",
    parentSessionId: "root-123",
    role: "worker",
    mode: "collaborative",
    depth: 1,
    nickname: null,
    requestedModel: null,
    effectiveModel: "gpt-5.4",
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: "running",
    lastMessagePreview: null,
    agents: [],
    workflowRuns: [],
    sessionUsage: null,
    lastTurnUsage: null,
    enableMcp: true,
    busy: true,
    busySince: "2026-03-15T10:05:00.000Z",
    activeTurnId: "turn-1",
    pendingSteer: null,
    feed: [
      {
        id: "msg-user-1",
        kind: "message",
        role: "user",
        ts: "2026-03-15T10:04:00.000Z",
        text: "Investigate the parser regression.",
      },
      {
        id: "msg-assistant-1",
        kind: "message",
        role: "assistant",
        ts: "2026-03-15T10:04:30.000Z",
        text: "Reading the parser tests now.",
      },
      {
        id: "msg-assistant-2",
        kind: "message",
        role: "assistant",
        ts: "2026-03-15T10:04:45.000Z",
        text: 'Finished the investigation. <workflow_result>{"findings": "Parser regression isolated."}</workflow_result> <agent_report>{"status":"completed","summary":"Produced the parser report."}</agent_report>',
      },
    ],
    transcriptOnly: false,
    ...overrides,
  };
}

describe("openAgentThread viewer routing", () => {
  beforeEach(() => {
    useAppStore.setState({
      ...defaultStoreState,
      ready: true,
      threads: [parentThreadRecord()],
      workspaces: [{ id: "ws-1", path: "/tmp/workspace", name: "Workspace" }],
      selectedThreadId: PARENT_THREAD_ID,
      selectedWorkspaceId: "ws-1",
      threadRuntimeById: {
        [PARENT_THREAD_ID]: { sessionId: "root-123", agents: [parentAgentSummary()] },
      },
      agentViewerThreadId: null,
    } as any);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  test("opens the run viewer without taking over the selected thread", async () => {
    const reconnectCalls: Array<{ threadId: string; opts?: unknown }> = [];
    useAppStore.setState({
      reconnectThread: (async (threadId: string, _firstMessage?: unknown, opts?: unknown) => {
        reconnectCalls.push({ threadId, opts });
        return true;
      }) as any,
    });

    await useAppStore.getState().openAgentThread(AGENT_ID);

    const state = useAppStore.getState();
    expect(state.agentViewerThreadId).toBe(AGENT_ID);
    expect(state.selectedThreadId).toBe(PARENT_THREAD_ID);

    const agentThread = state.threads.find((thread) => thread.id === AGENT_ID);
    expect(agentThread?.sessionKind).toBe("agent");
    expect(agentThread?.parentSessionId).toBe("root-123");
    expect(agentThread?.title).toBe("Investigate parser test");
    expect(agentThread?.sessionId).toBe(AGENT_ID);
    expect(agentThread?.draft).toBe(false);
    expect(agentThread?.archived).toBe(false);

    expect(reconnectCalls).toEqual([{ threadId: AGENT_ID, opts: { skipWorkspaceSelect: true } }]);
  });

  test("reuses the existing hidden record, honors title overrides, and closes", async () => {
    useAppStore.setState({ reconnectThread: (async () => true) as any });
    useAppStore.setState({
      threads: [
        parentThreadRecord(),
        agentThreadRecord({ title: "Old title", createdAt: "2026-03-01T00:00:00.000Z" }),
      ],
    });

    await useAppStore.getState().openAgentThread(AGENT_ID, "Custom run title");

    const agentThread = useAppStore.getState().threads.find((thread) => thread.id === AGENT_ID);
    expect(agentThread?.title).toBe("Custom run title");
    expect(agentThread?.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(useAppStore.getState().agentViewerThreadId).toBe(AGENT_ID);

    useAppStore.getState().closeAgentViewer();
    expect(useAppStore.getState().agentViewerThreadId).toBeNull();
    expect(useAppStore.getState().selectedThreadId).toBe(PARENT_THREAD_ID);
  });

  test("ignores blank ids, missing parents, and nested agent threads", async () => {
    const reconnectCalls: string[] = [];
    useAppStore.setState({
      reconnectThread: (async (threadId: string) => {
        reconnectCalls.push(threadId);
        return true;
      }) as any,
    });

    await useAppStore.getState().openAgentThread("   ");
    expect(useAppStore.getState().agentViewerThreadId).toBeNull();

    useAppStore.setState({ selectedThreadId: null });
    await useAppStore.getState().openAgentThread(AGENT_ID);
    expect(useAppStore.getState().agentViewerThreadId).toBeNull();

    useAppStore.setState({
      threads: [parentThreadRecord(), agentThreadRecord()],
      selectedThreadId: AGENT_ID,
    });
    await useAppStore.getState().openAgentThread("other-agent");
    expect(useAppStore.getState().agentViewerThreadId).toBeNull();

    expect(reconnectCalls).toEqual([]);
  });
});

describe("formatAgentRunMessageText", () => {
  test("leaves plain text untouched", () => {
    const text = "Just a normal assistant reply.";
    expect(formatAgentRunMessageText(text)).toBe(text);
  });

  test("unwraps a workflow_result JSON string envelope into prose", () => {
    const text = 'Intro. <workflow_result>"Line one.\\n- item A\\n- item B"</workflow_result>';
    const formatted = formatAgentRunMessageText(text);
    expect(formatted).toContain("Line one.\n- item A\n- item B");
    expect(formatted).not.toContain("<workflow_result>");
    expect(formatted).toContain("Intro.");
  });

  test("pretty-prints a workflow_result JSON object envelope", () => {
    const text = '<workflow_result>{"findings": "isolated", "count": 2}</workflow_result>';
    const formatted = formatAgentRunMessageText(text);
    expect(formatted).toContain("```json");
    expect(formatted).toContain('"findings": "isolated"');
    expect(formatted).not.toContain("<workflow_result>");
  });

  test("fences a workflow_result body that is not JSON", () => {
    const text = '<workflow_result>still streaming partial json {"a":</workflow_result>';
    const formatted = formatAgentRunMessageText(text);
    expect(formatted).toContain("```text");
    expect(formatted).toContain('still streaming partial json {"a":');
    expect(formatted).not.toContain("<workflow_result>");
  });

  test("renders a valid agent_report footer as a report card", () => {
    const report = JSON.stringify({
      status: "completed",
      summary: "Produced the parser report.",
      filesChanged: ["src/parser.ts"],
      filesRead: ["a.ts", "b.ts"],
      verification: [{ command: "bun test", outcome: "passed" }],
      residualRisks: ["Edge case remains"],
    });
    const formatted = formatAgentRunMessageText(
      `Answer text. <agent_report>${report}</agent_report>`,
    );
    expect(formatted).toContain("**Report to main agent** · finished");
    expect(formatted).toContain("> Produced the parser report.");
    expect(formatted).toContain("**Files changed:** `src/parser.ts`");
    expect(formatted).toContain("**Files read:** 2 files");
    expect(formatted).toContain("- `bun test` — passed");
    expect(formatted).toContain("- Edge case remains");
    expect(formatted).not.toContain("<agent_report>");
    expect(formatted).toContain("Answer text.");
  });

  test("fences an agent_report body that is not valid JSON", () => {
    const formatted = formatAgentRunMessageText("Text. <agent_report>{not json}</agent_report>");
    expect(formatted).toContain("```text");
    expect(formatted).toContain("{not json}");
    expect(formatted).not.toContain("<agent_report>");
  });

  test("handles an unterminated footer while the run is still streaming", () => {
    const formatted = formatAgentRunMessageText('Text. <agent_report>{"status":"comple');
    expect(formatted).not.toContain("<agent_report>");
    expect(formatted).toContain("```text");
  });
});

describe("formatAgentRunFeedForViewer", () => {
  test("only rewrites assistant messages and preserves feed identity when unchanged", () => {
    const feed = [
      { id: "u1", kind: "message", role: "user", ts: "2026-03-15T10:00:00.000Z", text: "hi" },
      {
        id: "a1",
        kind: "message",
        role: "assistant",
        ts: "2026-03-15T10:01:00.000Z",
        text: "hello",
      },
    ] as any;
    expect(formatAgentRunFeedForViewer(feed)).toBe(feed);
  });

  test("rewrites assistant footers but leaves user text with tags alone", () => {
    const feed = [
      {
        id: "u1",
        kind: "message",
        role: "user",
        ts: "2026-03-15T10:00:00.000Z",
        text: "show me <agent_report> output",
      },
      {
        id: "a1",
        kind: "message",
        role: "assistant",
        ts: "2026-03-15T10:01:00.000Z",
        text: 'done <agent_report>{"status":"completed","summary":"ok"}</agent_report>',
      },
    ] as any;
    const formatted = formatAgentRunFeedForViewer(feed);
    expect(formatted).not.toBe(feed);
    expect(formatted[0].text).toBe("show me <agent_report> output");
    expect(formatted[1].text).toContain("**Report to main agent** · finished");
    expect(formatted[1].id).toBe("a1");
  });
});

describe("AgentRunViewer", () => {
  afterEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  test("renders the active run read-only in a right-side slide-over", async () => {
    const harness = setupJsdom({
      includeAnimationFrame: {
        requestAnimationFrame: requestAnimationFrameMock,
        cancelAnimationFrame: cancelAnimationFrameMock,
      },
      extraGlobals: { MutationObserver: MockMutationObserver, ResizeObserver: MockResizeObserver },
    });
    try {
      useAppStore.setState({
        ...defaultStoreState,
        ready: true,
        threads: [parentThreadRecord(), agentThreadRecord()],
        workspaces: [{ id: "ws-1", path: "/tmp/workspace", name: "Workspace" }],
        selectedThreadId: PARENT_THREAD_ID,
        agentViewerThreadId: AGENT_ID,
        threadRuntimeById: { [AGENT_ID]: agentRuntime() },
      } as any);

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(createElement(OverlayStackProvider, null, createElement(AgentRunViewer)));
        });

        const document = harness.dom.window.document;
        const viewer = document.querySelector('[data-slot="agent-run-viewer"]');
        expect(viewer).not.toBeNull();
        expect(viewer?.className).toContain("right-3");
        expect(viewer?.className).toContain(
          "top-[calc(var(--platform-drag-strip-height)+var(--platform-titlebar-height)+0.75rem)]",
        );
        expect(viewer?.className).toContain("rounded-2xl");
        // Explicit border token: bare `border` would fall back to currentColor
        // (near-black) because the app does not set --default-border-color.
        expect(viewer?.className).toContain("border-border");
        expect(viewer?.className).toContain("overflow-hidden");
        expect(viewer?.className).toContain("app-surface-opaque");
        expect(viewer?.className).not.toContain("backdrop-blur");
        expect(viewer?.className).toContain("shadow-none");
        expect(viewer?.className).toContain("slide-in-from-right");
        // The UI behind stays visible: no dark scrim behind the panel.
        expect(document.querySelector('[data-slot="dialog-overlay"]')?.className).toContain(
          "bg-transparent",
        );
        expect(viewer?.textContent).toContain("Investigate parser test");
        expect(viewer?.textContent).toContain("running");
        expect(viewer?.textContent).toContain("worker · depth 1 · gpt-5.4");
        // Mid-turn assistant text folds into the collapsed activity group; the
        // final message renders in full.
        expect(viewer?.textContent).toContain("Finished the investigation.");
        // Protocol footers render as a structured card, not raw XML/JSON dumps.
        expect(viewer?.textContent).toContain("Report to main agent");
        expect(viewer?.textContent).toContain("finished");
        expect(viewer?.textContent).toContain("Produced the parser report.");
        expect(viewer?.textContent).not.toContain("<agent_report>");
        expect(viewer?.textContent).not.toContain("<workflow_result>");

        // Read-only: no composer, message input, or interaction affordances.
        expect(document.querySelector("textarea")).toBeNull();
        expect(viewer?.querySelector("input")).toBeNull();
        expect(document.querySelector('[role="textbox"]')).toBeNull();
        expect(viewer?.querySelector('[data-slot="message-bar"]')).toBeNull();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    } finally {
      harness.restore();
    }
  });

  test("renders nothing when no agent run is being viewed", async () => {
    const harness = setupJsdom({
      includeAnimationFrame: {
        requestAnimationFrame: requestAnimationFrameMock,
        cancelAnimationFrame: cancelAnimationFrameMock,
      },
      extraGlobals: { MutationObserver: MockMutationObserver, ResizeObserver: MockResizeObserver },
    });
    try {
      useAppStore.setState({
        ...defaultStoreState,
        ready: true,
        threads: [parentThreadRecord()],
        selectedThreadId: PARENT_THREAD_ID,
        agentViewerThreadId: null,
        threadRuntimeById: {},
      } as any);

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(createElement(OverlayStackProvider, null, createElement(AgentRunViewer)));
        });

        expect(
          harness.dom.window.document.querySelector('[data-slot="agent-run-viewer"]'),
        ).toBeNull();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    } finally {
      harness.restore();
    }
  });
});
