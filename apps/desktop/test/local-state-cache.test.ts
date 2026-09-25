import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";

const storage = new Map<string, string>();
let setItemError: Error | null = null;

const localStorageMock = {
  getItem(key: string) {
    return storage.has(key) ? storage.get(key)! : null;
  },
  setItem(key: string, value: string) {
    if (setItemError) throw setItemError;
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installWindowMock() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage: localStorageMock },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorageMock,
  });
}

function restoreWindowMock() {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).window;
  }

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
}

installWindowMock();

const { DESKTOP_STATE_CACHE_KEY, loadDesktopStateCacheRaw, saveDesktopStateCache } = await import(
  "../src/app/localStateCache"
);
const { saveServerUrl, saveWorkspacePath } = await import("../src/lib/webWorkspaceState");

describe("desktop local state cache", () => {
  beforeEach(() => {
    storage.clear();
    setItemError = null;
  });

  test("logs the first failed cache write once instead of failing silently", async () => {
    const rendererLogs: unknown[] = [];
    (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = {
      writeRendererLog: async (entry: unknown) => {
        rendererLogs.push(entry);
      },
    };
    setItemError = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const cacheState = {
      version: 2,
      persistedState: { version: 2, workspaces: [], threads: [] },
      ui: { view: "chat" },
      sessionSnapshots: {},
    } as any;

    try {
      saveDesktopStateCache(cacheState);
      saveDesktopStateCache(cacheState);
      await Promise.resolve();

      expect(rendererLogs).toEqual([
        expect.objectContaining({
          level: "warn",
          category: "local-state-cache",
          meta: expect.objectContaining({ error: "QuotaExceededError" }),
        }),
      ]);
    } finally {
      delete (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
    }
  });

  test("uses a scoped cache key for the active browser workspace", () => {
    saveServerUrl("ws://127.0.0.1:7337/ws");
    saveWorkspacePath("/tmp/workspace-one");
    saveDesktopStateCache({
      version: 2,
      persistedState: { version: 2, workspaces: [], threads: [] },
      ui: { view: "chat" },
      sessionSnapshots: {},
    } as any);

    const scopedKeys = [...storage.keys()].filter((key) =>
      key.startsWith(`${DESKTOP_STATE_CACHE_KEY}:`),
    );
    expect(scopedKeys).toHaveLength(1);
    expect(loadDesktopStateCacheRaw()).not.toBeNull();

    saveServerUrl("ws://127.0.0.1:7444/ws");
    saveWorkspacePath("/tmp/workspace-two");

    expect(loadDesktopStateCacheRaw()).toBeNull();
  });
});

afterAll(() => {
  restoreWindowMock();
});
