import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import "fake-indexeddb/auto";
import { setupJsdom } from "./jsdomHarness";

const storage = new Map<string, string>();
const transcriptEvent = {
  ts: "2026-07-10T07:00:00.000Z",
  threadId: "thread-web-transcript",
  direction: "server" as const,
  payload: { type: "agent_message", text: "Persist me" },
};

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

class TestBroadcastChannel {
  postMessage(_value: unknown): void {}
  addEventListener(_type: "message", _listener: () => void): void {}
  removeEventListener(_type: "message", _listener: () => void): void {}
  close(): void {}
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalBroadcastChannelDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "BroadcastChannel",
);
const originalInjectedServerUrlDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "__COWORK_SERVER_URL__",
);
const originalInjectedBrowserAccessTokenDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "__COWORK_BROWSER_ACCESS_TOKEN__",
);

function installWindowMock(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        host: "localhost:8281",
      },
      localStorage: localStorageMock,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorageMock,
  });
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    writable: true,
    value: TestBroadcastChannel,
  });
  Object.defineProperty(globalThis, "__COWORK_SERVER_URL__", {
    configurable: true,
    writable: true,
    value: "ws://127.0.0.1:7337/ws",
  });
  Object.defineProperty(globalThis, "__COWORK_BROWSER_ACCESS_TOKEN__", {
    configurable: true,
    writable: true,
    value: "browser-secret",
  });
}

function restoreDescriptor(key: string, descriptor?: PropertyDescriptor): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

installWindowMock();

const {
  browserAccessHeaders,
  configureWebAdapter,
  createWebAdapter,
  deriveSameOriginServerUrl,
  normalizeWebServerUrl,
  withBrowserAccessToken,
} = await import("../src/lib/webAdapter");
const { getCurrentWebWorkspaceScopeKey } = await import("../src/lib/webWorkspaceState");

let workspaceSequence = 0;

function configureUniqueWorkspace(): void {
  workspaceSequence += 1;
  configureWebAdapter(
    "ws://127.0.0.1:7337/ws",
    `/tmp/web-transcript-workspace-${workspaceSequence}-${crypto.randomUUID()}`,
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(predicate()).toBe(true);
}

describe("webAdapter connection isolation", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("never sends injected credentials to a query-selected foreign endpoint", () => {
    const query = new URLSearchParams("server=wss%3A%2F%2Funrelated.invalid%2Fws&dir=%2Ftmp");
    const serverUrl = query.get("server")!;
    configureWebAdapter(serverUrl, query.get("dir")!);

    expect(withBrowserAccessToken(serverUrl)).toBe(serverUrl);
    expect(browserAccessHeaders(serverUrl)).toEqual({});
    expect(browserAccessHeaders("https://unrelated.invalid/cowork/desktop/state")).toEqual({});
    expect(browserAccessHeaders("http://127.0.0.1:7444/cowork/desktop/state")).toEqual({});
    expect(browserAccessHeaders("https://127.0.0.1:7337/cowork/desktop/state")).toEqual({});
  });

  test("authenticates the issuer and its same-origin proxy without replacing endpoint credentials", () => {
    expect(
      new URL(withBrowserAccessToken("ws://127.0.0.1:7337/ws")).searchParams.get(
        "coworkBrowserToken",
      ),
    ).toBe("browser-secret");
    expect(browserAccessHeaders("http://127.0.0.1:7337/cowork/desktop/state")).toEqual({
      "X-Cowork-Browser-Token": "browser-secret",
    });
    expect(browserAccessHeaders("http://localhost:8281/cowork/desktop/state")).toEqual({
      "X-Cowork-Browser-Token": "browser-secret",
    });
    const childUrl = "ws://127.0.0.1:7444/ws?coworkBrowserToken=child-secret";
    expect(withBrowserAccessToken(childUrl)).toBe(childUrl);
    expect(browserAccessHeaders(childUrl)).toEqual({ "X-Cowork-Browser-Token": "child-secret" });
    const explicitUrl = "ws://127.0.0.1:7337/ws?coworkBrowserToken=explicit-secret";
    expect(withBrowserAccessToken(explicitUrl)).toBe(explicitUrl);
  });

  test("keeps each adapter's requests and fallback state scoped when another tab reconnects", async () => {
    const requests: string[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(String(input));
      return new Response("missing", { status: 404 });
    });
    try {
      configureWebAdapter("ws://first.invalid/ws", "/tmp/first");
      const first = createWebAdapter();
      const firstState = await first.loadState();
      firstState.developerMode = true;

      configureWebAdapter("ws://second.invalid/ws", "/tmp/second");
      const second = createWebAdapter();
      const secondState = await second.loadState();
      secondState.showHiddenFiles = true;

      await first.saveState(firstState);
      await second.saveState(secondState);
      const reloadedFirst = await first.loadState();
      const reloadedSecond = await second.loadState();

      expect(reloadedFirst.workspaces.map((workspace) => workspace.path)).toEqual(["/tmp/first"]);
      expect(reloadedFirst.developerMode).toBe(true);
      expect(reloadedFirst.showHiddenFiles).toBe(false);
      expect(reloadedSecond.workspaces.map((workspace) => workspace.path)).toEqual(["/tmp/second"]);
      expect(reloadedSecond.developerMode).toBe(false);
      expect(reloadedSecond.showHiddenFiles).toBe(true);
      expect(requests.map((url) => new URL(url).host)).toEqual([
        "first.invalid",
        "second.invalid",
        "first.invalid",
        "second.invalid",
        "first.invalid",
        "second.invalid",
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("keeps the current tab cache namespace when another tab changes saved connection preferences", () => {
    configureWebAdapter("ws://first.invalid/ws", "/tmp/first");
    const scope = getCurrentWebWorkspaceScopeKey();
    localStorageMock.setItem("cowork:web:serverUrl", "ws://second.invalid/ws");
    localStorageMock.setItem("cowork:web:workspacePath", "/tmp/second");
    expect(getCurrentWebWorkspaceScopeKey()).toBe(scope);
  });

  test("applies browser action sheet layout styles", async () => {
    const harness = setupJsdom();
    try {
      configureWebAdapter("ws://127.0.0.1:7337/ws", "/tmp/action-sheet");
      const adapter = createWebAdapter();
      const selection = adapter.showContextMenu({ items: [{ id: "copy", label: "Copy" }] });
      const overlay = document.body.lastElementChild as HTMLElement;
      const panel = overlay.firstElementChild as HTMLElement;
      expect(overlay.style.zIndex).toBe("9999");
      expect(overlay.style.alignItems).toBe("center");
      expect(panel.style.flexDirection).toBe("column");
      (panel.querySelector("button") as HTMLButtonElement).click();
      await expect(selection).resolves.toBe("copy");
    } finally {
      harness.restore();
    }
  });
});

describe("webAdapter transcript reliability", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("normalizes injected and direct websocket URLs", () => {
    expect(deriveSameOriginServerUrl()).toBe("ws://127.0.0.1:7337/ws");
    expect(normalizeWebServerUrl("ws://localhost:8281/ws")).toBe("ws://127.0.0.1:7337/ws");
    expect(normalizeWebServerUrl("ws://127.0.0.1:7337/ws")).toBe("ws://127.0.0.1:7337/ws");
  });

  test("enables full desktop browser mode without a workspace path", () => {
    configureWebAdapter("ws://127.0.0.1:7337/ws", "");
    const adapter = createWebAdapter();
    expect(adapter.features.workspacePicker).toBe(true);
    expect(adapter.features.workspaceLifecycle).toBe(true);
  });

  test("authenticates transcript requests and sends the captured generation", async () => {
    const originalFetch = globalThis.fetch;
    let request: { headers: Headers; body: string } | null = null;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (_input: string | URL | Request, init?: RequestInit) => {
        request = {
          headers: new Headers(init?.headers),
          body: String(init?.body ?? ""),
        };
        return new Response(null, { status: 204 });
      },
    });
    try {
      configureUniqueWorkspace();
      const adapter = createWebAdapter();
      const result = await adapter.captureTranscriptEvent?.(transcriptEvent);
      expect(result?.accepted).toBe(true);
      await waitFor(() => request !== null);

      expect(request?.headers.get("X-Cowork-Browser-Token")).toBe("browser-secret");
      const body = JSON.parse(request?.body ?? "") as {
        events: Array<{ generation?: number }>;
      };
      expect(body.events[0]?.generation).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });

  test("durably captures transcript events before the desktop debounce window", async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => {
        requestCount += 1;
        return new Response(null, { status: 204 });
      },
    });
    try {
      configureUniqueWorkspace();
      const adapter = createWebAdapter();
      window.cowork = adapter;
      const { createTranscriptBuffer } = await import("../src/app/store.helpers/transcriptBuffer");
      const buffer = createTranscriptBuffer({
        nowIso: () => transcriptEvent.ts,
        captureEvent: (event) => adapter.captureTranscriptEvent?.(event) ?? null,
      });
      buffer.appendThreadTranscript(
        transcriptEvent.threadId,
        transcriptEvent.direction,
        transcriptEvent.payload,
      );

      await waitFor(() => requestCount === 1, 150);
    } finally {
      window.cowork = undefined;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });

  test("treats a 404 transcript endpoint as an absent capability without accumulation", async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => {
        requestCount += 1;
        return new Response("missing", { status: 404 });
      },
    });
    try {
      configureUniqueWorkspace();
      const adapter = createWebAdapter();
      await adapter.captureTranscriptEvent?.(transcriptEvent);
      await waitFor(() => requestCount === 1);
      await adapter.captureTranscriptEvent?.({
        ...transcriptEvent,
        ts: "2026-07-10T07:00:01.000Z",
      });
      await Bun.sleep(25);
      expect(requestCount).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });

  test("surfaces permanent delivery recovery through adapter listeners", async () => {
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => new Response("unauthorized", { status: 401 }),
    });
    try {
      configureUniqueWorkspace();
      const adapter = createWebAdapter();
      const failures: Array<{ message: string; reason: string }> = [];
      const unsubscribe = adapter.onTranscriptDeliveryFailure?.((failure) => {
        failures.push(failure);
      });
      await adapter.captureTranscriptEvent?.(transcriptEvent);
      await waitFor(() => failures.length > 0);

      expect(failures).toContainEqual(
        expect.objectContaining({
          reason: "permanent",
          message: expect.stringContaining("Retry"),
        }),
      );
      unsubscribe?.();
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });
});

afterAll(() => {
  restoreDescriptor("window", originalWindowDescriptor);
  restoreDescriptor("localStorage", originalLocalStorageDescriptor);
  restoreDescriptor("BroadcastChannel", originalBroadcastChannelDescriptor);
  restoreDescriptor("__COWORK_SERVER_URL__", originalInjectedServerUrlDescriptor);
  restoreDescriptor(
    "__COWORK_BROWSER_ACCESS_TOKEN__",
    originalInjectedBrowserAccessTokenDescriptor,
  );
});
