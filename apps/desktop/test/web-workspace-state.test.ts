import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

const storage = new Map<string, string>();

const localStorageMock = {
  getItem(key: string) {
    return storage.has(key) ? storage.get(key)! : null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installLocalStorageMock() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorageMock,
  });
}

function restoreLocalStorageMock() {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>).localStorage;
}

installLocalStorageMock();

const {
  getCurrentWebWorkspaceScopeKey,
  loadPersistedState,
  savePersistedState,
  saveServerUrl,
  saveWorkspacePath,
  seedWorkspaceFromUrl,
} = await import("../src/lib/webWorkspaceState");

describe("web workspace state", () => {
  beforeEach(() => {
    storage.clear();
  });

  afterEach(() => {
    storage.clear();
  });

  test("scopes browser state by server URL and workspace path", () => {
    saveServerUrl("ws://127.0.0.1:7337/ws");
    saveWorkspacePath("/tmp/workspace-one");

    const firstState = seedWorkspaceFromUrl("ws://127.0.0.1:7337/ws", "/tmp/workspace-one");
    firstState.developerMode = true;
    firstState.threads.push({
      id: "thread-one",
      workspaceId: firstState.workspaces[0]!.id,
      title: "Thread One",
      titleSource: "manual",
      createdAt: "2026-04-18T00:00:00.000Z",
      lastMessageAt: "2026-04-18T00:00:00.000Z",
      status: "active",
      sessionId: null,
      messageCount: 0,
      lastEventSeq: 0,
    } as any);
    savePersistedState(firstState);

    saveServerUrl("ws://127.0.0.1:7444/ws");
    saveWorkspacePath("/tmp/workspace-two");

    const secondState = seedWorkspaceFromUrl("ws://127.0.0.1:7444/ws", "/tmp/workspace-two");
    expect(secondState.workspaces).toHaveLength(1);
    expect(secondState.workspaces[0]?.path).toBe("/tmp/workspace-two");
    expect(secondState.threads).toHaveLength(0);
    expect(secondState.developerMode).toBe(false);

    secondState.showHiddenFiles = true;
    savePersistedState(secondState);

    saveServerUrl("ws://127.0.0.1:7337/ws");
    saveWorkspacePath("/tmp/workspace-one");

    const reloadedFirstState = loadPersistedState();
    expect(reloadedFirstState.workspaces).toHaveLength(1);
    expect(reloadedFirstState.workspaces[0]?.path).toBe("/tmp/workspace-one");
    expect(reloadedFirstState.threads.map((thread) => thread.id)).toEqual(["thread-one"]);
    expect(reloadedFirstState.developerMode).toBe(true);
    expect(reloadedFirstState.showHiddenFiles).toBe(false);

    saveServerUrl("ws://127.0.0.1:7444/ws");
    saveWorkspacePath("/tmp/workspace-two");

    const reloadedSecondState = loadPersistedState();
    expect(reloadedSecondState.workspaces).toHaveLength(1);
    expect(reloadedSecondState.workspaces[0]?.path).toBe("/tmp/workspace-two");
    expect(reloadedSecondState.threads).toHaveLength(0);
    expect(reloadedSecondState.showHiddenFiles).toBe(true);
  });

  test("uses the full server and workspace tuple as the collision-safe outbox scope", () => {
    saveServerUrl("ws://127.0.0.1:7337/ws");
    saveWorkspacePath("/tmp/workspace:with-delimiters");

    expect(JSON.parse(getCurrentWebWorkspaceScopeKey() ?? "null")).toEqual([
      "ws://127.0.0.1:7337/ws",
      "/tmp/workspace:with-delimiters",
    ]);
  });

  test("preserves desktop feature flag overrides in localStorage-backed state", () => {
    saveServerUrl("ws://127.0.0.1:7337/ws");
    saveWorkspacePath("/tmp/workspace-one");

    const state = seedWorkspaceFromUrl("ws://127.0.0.1:7337/ws", "/tmp/workspace-one");
    state.desktopFeatureFlagOverrides = {
      remoteAccess: false,
      workspacePicker: true,
    };
    savePersistedState(state);

    const reloaded = loadPersistedState();
    expect(reloaded.desktopFeatureFlagOverrides).toEqual({
      remoteAccess: false,
      workspacePicker: true,
    });
  });
});

afterAll(() => {
  restoreLocalStorageMock();
});
