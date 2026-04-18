import { afterAll, beforeEach, describe, expect, test } from "bun:test";

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

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalInjectedServerUrlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "__COWORK_SERVER_URL__");

function installWindowMock() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        host: "localhost:8281",
      },
      localStorage: localStorageMock,
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorageMock,
  });
  Object.defineProperty(globalThis, "__COWORK_SERVER_URL__", {
    configurable: true,
    writable: true,
    value: "ws://127.0.0.1:7337/ws",
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

  if (originalInjectedServerUrlDescriptor) {
    Object.defineProperty(globalThis, "__COWORK_SERVER_URL__", originalInjectedServerUrlDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).__COWORK_SERVER_URL__;
  }
}

installWindowMock();

const {
  configureWebAdapter,
  createWebAdapter,
  deriveSameOriginServerUrl,
  normalizeWebServerUrl,
} = await import("../src/lib/webAdapter");

describe("webAdapter server URL normalization", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("derives the live Cowork websocket URL injected by the web dev shell", () => {
    expect(deriveSameOriginServerUrl()).toBe("ws://127.0.0.1:7337/ws");
  });

  test("normalizes legacy same-origin websocket URLs onto the injected Cowork server URL", () => {
    expect(normalizeWebServerUrl("ws://localhost:8281/ws")).toBe("ws://127.0.0.1:7337/ws");
  });

  test("leaves direct Cowork server websocket URLs unchanged", () => {
    expect(normalizeWebServerUrl("ws://127.0.0.1:7337/ws")).toBe("ws://127.0.0.1:7337/ws");
  });

  test("enables full desktop browser mode when connected without a workspace path", async () => {
    const originalFetch = globalThis.fetch;
    const desktopState = {
      version: 2,
      workspaces: [{
        id: "ws_full",
        name: "Full Desktop",
        path: "/tmp/full-desktop",
        createdAt: "2026-04-18T00:00:00.000Z",
        lastOpenedAt: "2026-04-18T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      }],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      perWorkspaceSettings: false,
    };

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => new Response(JSON.stringify(desktopState), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });

    configureWebAdapter("ws://127.0.0.1:7337/ws", "");
    const adapter = createWebAdapter();
    expect(adapter.features.workspacePicker).toBe(true);
    expect(adapter.features.workspaceLifecycle).toBe(true);
    await expect(adapter.loadState()).resolves.toEqual(desktopState);

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  });

  test("falls back to the server workspace list when the desktop service is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    const responses = new Map<string, Response>([
      ["http://127.0.0.1:7337/cowork/desktop/state", new Response("missing", { status: 404 })],
      ["http://127.0.0.1:7337/cowork/workspaces", new Response(JSON.stringify({
        workspaces: [{ name: "Repo", path: "/tmp/repo" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })],
    ]);

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: string | URL | Request) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        const response = responses.get(url);
        if (!response) {
          throw new Error(`Unexpected fetch: ${url}`);
        }
        return response.clone();
      },
    });

    configureWebAdapter("ws://127.0.0.1:7337/ws", "");
    const adapter = createWebAdapter();
    const state = await adapter.loadState();
    expect(adapter.features.workspacePicker).toBe(true);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]?.path).toBe("/tmp/repo");
    expect(state.workspaces[0]?.name).toBe("repo");

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  });
});

afterAll(() => {
  restoreWindowMock();
});
