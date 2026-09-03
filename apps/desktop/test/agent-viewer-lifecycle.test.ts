import { beforeEach as resetNavigationBeforeEach } from "bun:test";
import { appNavigation } from "../src/app/navigation";
import { setAppState } from "./helpers/navigation";

resetNavigationBeforeEach(() =>
  appNavigation.update({ view: "chat", settingsPage: "models", lastNonSettingsView: "chat" }, true),
);

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionSnapshot } from "../src/app/types";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { installDesktopCommandsBridge } from "./helpers/desktopCommandsBridge";
import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";

installDesktopCommandsBridge();

const WORKSPACE_ID = "agent-viewer-workspace";
const PARENT_THREAD_ID = "parent-thread";
const PARENT_SESSION_ID = "parent-session";
const FIRST_AGENT_ID = "first-agent";
const SECOND_AGENT_ID = "second-agent";

const requests: Array<{ method: string; threadId?: string }> = [];

function threadMetadata(threadId: string) {
  return {
    id: threadId,
    title: `Thread ${threadId}`,
    modelProvider: "openai",
    model: "gpt-5.4",
    cwd: "/tmp/agent-viewer-workspace",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:01.000Z",
    status: { type: "loaded" },
  };
}

function threadSnapshot(threadId: string): SessionSnapshot {
  const isAgent = threadId !== PARENT_SESSION_ID;
  return {
    sessionId: threadId,
    title: `Snapshot ${threadId}`,
    titleSource: "model",
    titleModel: "gpt-5.4",
    provider: "openai",
    model: "gpt-5.4",
    sessionKind: isAgent ? "agent" : "root",
    parentSessionId: isAgent ? PARENT_SESSION_ID : null,
    role: null,
    mode: null,
    depth: isAgent ? 1 : 0,
    nickname: null,
    taskType: null,
    targetPaths: null,
    profile: null,
    requestedModel: "gpt-5.4",
    effectiveModel: "gpt-5.4",
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:01.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    feed: [],
    agents: [],
    workflowRuns: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

class MockJsonRpcSocket {
  readonly readyPromise = Promise.resolve();

  constructor(public readonly opts: { onOpen?: () => void; onClose?: () => void }) {}

  connect() {
    this.opts.onOpen?.();
  }

  async request(method: string, params?: { threadId?: string }) {
    requests.push({ method, ...(params?.threadId ? { threadId: params.threadId } : {}) });
    switch (method) {
      case "thread/list":
        return { threads: [threadMetadata(PARENT_SESSION_ID)] };
      case "thread/resume":
        return { thread: threadMetadata(params?.threadId ?? PARENT_SESSION_ID) };
      case "thread/read":
        return { coworkSnapshot: threadSnapshot(params?.threadId ?? PARENT_SESSION_ID) };
      case "thread/unsubscribe":
        return { status: "unsubscribed" };
      default:
        return {};
    }
  }

  respond() {
    return true;
  }

  close() {
    this.opts.onClose?.();
  }
}

const desktopApiMock = createDesktopApiMock({
  getWorkspaceServerStatus: async ({ workspaceId }) => ({
    workspaceId,
    running: true,
    url: "ws://agent-viewer",
    reason: "running",
  }),
  saveState: async () => {},
});

const { useAppStore } = await import("../src/app/store");
const {
  __threadEventReducerInternal,
  defaultThreadRuntime,
  defaultWorkspaceRuntime,
  persistNow,
  RUNTIME,
} = await import("../src/app/store.helpers");

const initialStoreState = useAppStore.getState();

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for viewer state`);
    }
    await Bun.sleep(0);
  }
}

function reconnectThreadIds(): string[] {
  return __threadEventReducerInternal.getWorkspaceStateSnapshot(WORKSPACE_ID).reconnectThreadIds;
}

function unsubscribeRequests(): string[] {
  return requests
    .filter((request) => request.method === "thread/unsubscribe")
    .map((request) => request.threadId ?? "");
}

async function connectParentThread(): Promise<void> {
  await useAppStore
    .getState()
    .reconnectThread(PARENT_THREAD_ID, undefined, { skipWorkspaceSelect: true });
  await waitFor(() => reconnectThreadIds().includes(PARENT_THREAD_ID));
}

async function openConnectedAgent(agentId: string): Promise<void> {
  await useAppStore.getState().openAgentThread(agentId);
  await waitFor(() => reconnectThreadIds().includes(agentId));
}

function deferFirstAgentReconnect(agentId: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconnectThread = useAppStore.getState().reconnectThread;
  let shouldDefer = true;

  setAppState(useAppStore, {
    reconnectThread: async (threadId, firstMessage, options) => {
      if (threadId === agentId && shouldDefer) {
        shouldDefer = false;
        await gate;
      }
      return await reconnectThread(threadId, firstMessage, options);
    },
  });

  return release;
}

describe("agent viewer subscription lifecycle", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = desktopApiMock;
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    requests.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.threadSelectionRequests.clear();
    __threadEventReducerInternal.reset(WORKSPACE_ID);

    setAppState(useAppStore, {
      ...initialStoreState,
      ready: true,
      navigation: { view: "chat" },
      selectedWorkspaceId: WORKSPACE_ID,
      selectedThreadId: PARENT_THREAD_ID,
      agentViewerThreadId: null,
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: "Workspace",
          path: "/tmp/agent-viewer-workspace",
          createdAt: "2026-08-24T00:00:00.000Z",
          lastOpenedAt: "2026-08-24T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      threads: [
        {
          id: PARENT_THREAD_ID,
          workspaceId: WORKSPACE_ID,
          sessionKind: "root",
          parentSessionId: null,
          title: "Parent chat",
          createdAt: "2026-08-24T00:00:00.000Z",
          lastMessageAt: "2026-08-24T00:00:01.000Z",
          status: "active",
          sessionId: PARENT_SESSION_ID,
          messageCount: 0,
          lastEventSeq: 0,
        },
      ],
      workspaceRuntimeById: {
        [WORKSPACE_ID]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://agent-viewer",
        },
      },
      threadRuntimeById: {
        [PARENT_THREAD_ID]: {
          ...defaultThreadRuntime(),
          sessionId: PARENT_SESSION_ID,
          sessionKind: "root",
        },
      },
      notifications: [],
      latestTodosByThreadId: {},
      interactionsByThread: {},
      applyWorkspaceDefaultsToThread: async () => {},
    });
  });

  afterEach(async () => {
    await persistNow(useAppStore.getState);
    __threadEventReducerInternal.reset(WORKSPACE_ID);
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    clearJsonRpcSocketOverride();
    delete (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
    setAppState(useAppStore, initialStoreState);
  });

  test("closing the viewer unsubscribes its child without interrupting the parent or agent", async () => {
    await connectParentThread();
    await openConnectedAgent(FIRST_AGENT_ID);

    useAppStore.getState().closeAgentViewer();
    await waitFor(() => unsubscribeRequests().length === 1);

    expect(unsubscribeRequests()).toEqual([FIRST_AGENT_ID]);
    expect(reconnectThreadIds()).toEqual([PARENT_THREAD_ID]);
    expect(useAppStore.getState().selectedThreadId).toBe(PARENT_THREAD_ID);
    expect(useAppStore.getState().agentViewerThreadId).toBeNull();
    expect(requests.some((request) => request.method === "turn/interrupt")).toBe(false);
  });

  test("switching viewers unsubscribes only the previously displayed child", async () => {
    await connectParentThread();
    await openConnectedAgent(FIRST_AGENT_ID);

    await openConnectedAgent(SECOND_AGENT_ID);
    await waitFor(() => unsubscribeRequests().length === 1);

    expect(unsubscribeRequests()).toEqual([FIRST_AGENT_ID]);
    expect(reconnectThreadIds()).toEqual([PARENT_THREAD_ID, SECOND_AGENT_ID]);
    expect(useAppStore.getState().selectedThreadId).toBe(PARENT_THREAD_ID);
    expect(useAppStore.getState().agentViewerThreadId).toBe(SECOND_AGENT_ID);
    expect(requests.some((request) => request.method === "turn/interrupt")).toBe(false);
  });

  test("a stale delayed reconnect cannot retain its subscription or close the current viewer", async () => {
    await connectParentThread();
    const releaseReconnect = deferFirstAgentReconnect(FIRST_AGENT_ID);
    const staleOpen = useAppStore.getState().openAgentThread(FIRST_AGENT_ID);

    await openConnectedAgent(SECOND_AGENT_ID);
    releaseReconnect();
    await staleOpen;
    await waitFor(() => !reconnectThreadIds().includes(FIRST_AGENT_ID));

    expect(reconnectThreadIds()).toEqual([PARENT_THREAD_ID, SECOND_AGENT_ID]);
    expect(unsubscribeRequests().every((threadId) => threadId === FIRST_AGENT_ID)).toBe(true);
    expect(useAppStore.getState().selectedThreadId).toBe(PARENT_THREAD_ID);
    expect(useAppStore.getState().agentViewerThreadId).toBe(SECOND_AGENT_ID);
  });

  test("an older reconnect never unsubscribes a viewer reopened for the same agent", async () => {
    await connectParentThread();
    const releaseReconnect = deferFirstAgentReconnect(FIRST_AGENT_ID);
    const staleOpen = useAppStore.getState().openAgentThread(FIRST_AGENT_ID);

    useAppStore.getState().closeAgentViewer();
    await openConnectedAgent(FIRST_AGENT_ID);
    const previousUnsubscribeCount = unsubscribeRequests().length;

    releaseReconnect();
    await staleOpen;

    expect(unsubscribeRequests()).toHaveLength(previousUnsubscribeCount);
    expect(reconnectThreadIds()).toEqual([PARENT_THREAD_ID, FIRST_AGENT_ID]);
    expect(useAppStore.getState().selectedThreadId).toBe(PARENT_THREAD_ID);
    expect(useAppStore.getState().agentViewerThreadId).toBe(FIRST_AGENT_ID);
  });
});
