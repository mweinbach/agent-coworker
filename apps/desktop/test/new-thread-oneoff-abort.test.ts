import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { persistNow, RUNTIME } from "../src/app/store.helpers";
import { __internalOperationIntent } from "../src/app/store.helpers/operationIntent";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { installDesktopCommandsBridge } from "./helpers/desktopCommandsBridge";
import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";

installDesktopCommandsBridge();

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(
  predicate: () => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for test condition`);
    }
    await Promise.resolve();
  }
}

class MockJsonRpcSocket {
  readonly readyPromise = Promise.resolve();

  constructor(public readonly opts: { onOpen?: () => void; onClose?: () => void }) {}

  connect() {
    this.opts.onOpen?.();
  }

  async request() {
    return {};
  }

  respond() {
    return true;
  }

  close() {
    this.opts.onClose?.();
  }
}

const startDeferreds: Deferred<{ url: string }>[] = [];
const startCalls: Array<{ workspaceId: string; workspacePath: string }> = [];
const trashCalls: string[] = [];
const stopCalls: string[] = [];
let oneOffCreateStarted = 0;
let oneOffCreateDeferred: Deferred<{ name: string; path: string }> | null = null;
let nextOneOffPath = "/tmp/cowork-one-off-abort";

const desktopApiMock = createDesktopApiMock({
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  saveState: async () => {},
  createOneOffChatWorkspace: async () => {
    oneOffCreateStarted += 1;
    if (oneOffCreateDeferred) {
      return await oneOffCreateDeferred.promise;
    }
    return { name: "New chat", path: nextOneOffPath };
  },
  startWorkspaceServer: async (opts: { workspaceId: string; workspacePath: string }) => {
    startCalls.push({ workspaceId: opts.workspaceId, workspacePath: opts.workspacePath });
    const deferred = createDeferred<{ url: string }>();
    startDeferreds.push(deferred);
    return await deferred.promise;
  },
  getWorkspaceServerStatus: async ({ workspaceId }: { workspaceId: string }) => ({
    workspaceId,
    running: false,
    url: null,
    reason: "stopped",
  }),
  stopWorkspaceServer: async ({ workspaceId }: { workspaceId: string }) => {
    stopCalls.push(workspaceId);
  },
  trashPath: async ({ path }: { path: string }) => {
    trashCalls.push(path);
  },
});

const { useAppStore } = await import("../src/app/store");

function resetStore() {
  useAppStore.setState({
    ready: true,
    bootstrapPhase: "ready",
    startupError: null,
    view: "chat",
    workspaces: [],
    threads: [],
    selectedWorkspaceId: null,
    selectedThreadId: null,
    selectedTaskId: null,
    newChatLandingTarget: { kind: "oneOff" },
    workspaceRuntimeById: {},
    threadRuntimeById: {},
    notifications: [],
    composerDraftsByKey: {},
    composerSubmissionsByKey: {},
    quickChatPreparedWorkspaceId: null,
    desktopFeatureFlags: {
      menuBar: true,
      remoteAccess: false,
      workspacePicker: true,
      workspaceLifecycle: true,
      openAiNativeConnectors: false,
      canvas: false,
      tasks: false,
    },
  } as never);
}

describe("one-off newThread abort cleanup", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = desktopApiMock;
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    startDeferreds.length = 0;
    startCalls.length = 0;
    trashCalls.length = 0;
    stopCalls.length = 0;
    oneOffCreateStarted = 0;
    oneOffCreateDeferred = null;
    nextOneOffPath = "/tmp/cowork-one-off-abort";
    RUNTIME.optimisticUserMessageIds.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadAttachments.clear();
    RUNTIME.pendingThreadReferences.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.workspaceStartPromises.clear();
    RUNTIME.workspaceStartGenerations.clear();
    RUNTIME.jsonRpcSockets.clear();
    __internalOperationIntent.reset();
    resetStore();
  });

  afterEach(async () => {
    await persistNow(useAppStore.getState);
    clearJsonRpcSocketOverride();
    delete (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
  });

  test("abort during one-off workspace creation still trashes the created chat directory", async () => {
    oneOffCreateDeferred = createDeferred<{ name: string; path: string }>();
    const controller = new AbortController();

    const creation = useAppStore.getState().newThread({
      scope: "oneOff",
      signal: controller.signal,
    });
    await waitForCondition(() => oneOffCreateStarted === 1);
    controller.abort();
    expect(useAppStore.getState().workspaces).toEqual([]);
    expect(trashCalls).toEqual([]);

    oneOffCreateDeferred.resolve({
      name: "Abandoned chat",
      path: "/tmp/cowork-one-off-aborted-dir",
    });
    await expect(creation).resolves.toBe(false);
    expect(trashCalls).toEqual(["/tmp/cowork-one-off-aborted-dir"]);
    expect(useAppStore.getState().workspaces).toEqual([]);
    expect(useAppStore.getState().threads).toEqual([]);
    expect(startCalls).toEqual([]);
  });

  test("server start failure after one-off creation discards the workspace and trashes its path", async () => {
    nextOneOffPath = "/tmp/cowork-one-off-start-fail";

    const creation = useAppStore.getState().newThread({
      scope: "oneOff",
      firstMessage: "hello from a cancelled one-off",
    });
    await waitForCondition(() => startCalls.length === 1);

    const created = useAppStore
      .getState()
      .workspaces.find((workspace) => workspace.path === "/tmp/cowork-one-off-start-fail");
    expect(created?.workspaceKind).toBe("oneOffChat");
    expect(useAppStore.getState().threads).toHaveLength(1);

    startDeferreds[0]?.reject(new Error("server failed"));
    await expect(creation).resolves.toBe(false);

    const state = useAppStore.getState();
    expect(state.workspaces).toEqual([]);
    expect(state.threads).toEqual([]);
    expect(state.selectedThreadId).toBeNull();
    expect(trashCalls).toEqual(["/tmp/cowork-one-off-start-fail"]);
    expect(stopCalls).toContain(created?.id);
    expect(RUNTIME.pendingThreadMessages.size).toBe(0);
  });
});
