import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ConnectPage } from "../src/components/ConnectPage";
import * as webAdapter from "../src/lib/webAdapter";
import { setupJsdom } from "./jsdomHarness";

class DiscoveryWebSocket {
  static instances: DiscoveryWebSocket[] = [];
  static autoOpen = true;

  private listeners = new Map<string, (event: Event) => void>();
  closed = false;

  constructor(readonly url: string) {
    DiscoveryWebSocket.instances.push(this);
    if (DiscoveryWebSocket.autoOpen) {
      queueMicrotask(() => {
        if (!this.closed) this.emit("open");
      });
    }
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emit(type: string) {
    this.listeners.get(type)?.(new Event(type));
  }

  close() {
    this.closed = true;
  }
}

describe("connection discovery credential scope", () => {
  test.each([
    {
      name: "injected server",
      serverUrl: "ws://127.0.0.1:7337/ws",
      expectedToken: "issuer-test-token",
    },
    {
      name: "explicit child-server token",
      serverUrl: "ws://127.0.0.1:7444/ws?coworkBrowserToken=child-test-token",
      expectedToken: "child-test-token",
    },
    {
      name: "foreign server",
      serverUrl: "wss://other.example/ws",
      expectedToken: null,
    },
  ])("binds both discovery requests to the $name", async ({ serverUrl, expectedToken }) => {
    const requests: { url: string; headers: Headers }[] = [];
    const onConnect = mock(() => {});
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/cowork/desktop/state")) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        workspaces: [
          { name: "First", path: "/first" },
          { name: "Second", path: "/second" },
        ],
      });
    });
    const harness = setupJsdom({
      extraGlobals: {
        WebSocket: DiscoveryWebSocket,
        fetch: fetchMock,
        __COWORK_SERVER_URL__: "ws://127.0.0.1:7337/ws",
        __COWORK_BROWSER_ACCESS_TOKEN__: "issuer-test-token",
      },
    });
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(ConnectPage, { onConnect, initialServerUrl: serverUrl }));
        await Bun.sleep(0);
      });

      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/cowork/desktop/state",
        "/cowork/workspaces",
      ]);
      for (const request of requests) {
        expect(request.headers.get("X-Cowork-Browser-Token")).toBe(expectedToken);
      }
      expect(container.textContent).toContain("Select a workspace:");
      expect(onConnect).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      harness.restore();
    }
  });
});

describe("connection attempt lifecycle", () => {
  const serverUrl = "ws://127.0.0.1:7337/ws";
  const workspaces = [
    { name: "First", path: "/first" },
    { name: "Second", path: "/second" },
  ];
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let fetchMock: ReturnType<typeof mock<typeof fetch>>;
  let configure: ReturnType<typeof spyOn<typeof webAdapter, "configureWebAdapter">>;
  let createAdapter: ReturnType<typeof spyOn<typeof webAdapter, "createWebAdapter">>;
  let onConnect: ReturnType<typeof mock<() => void>>;

  beforeEach(() => {
    DiscoveryWebSocket.instances = [];
    DiscoveryWebSocket.autoOpen = true;
    fetchMock = mock(async (input) =>
      String(input).endsWith("/cowork/desktop/state")
        ? new Response(null, { status: 404 })
        : Response.json({ workspaces }),
    );
    onConnect = mock(() => {});
    configure = spyOn(webAdapter, "configureWebAdapter").mockImplementation(() => {});
    createAdapter = spyOn(webAdapter, "createWebAdapter").mockReturnValue(
      {} as ReturnType<typeof webAdapter.createWebAdapter>,
    );
    harness = setupJsdom({
      extraGlobals: { WebSocket: DiscoveryWebSocket, fetch: fetchMock },
    });
    const element = harness.dom.window.document.getElementById("root");
    if (!element) throw new Error("Missing test root");
    container = element;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    configure.mockRestore();
    createAdapter.mockRestore();
    harness.restore();
    DiscoveryWebSocket.autoOpen = true;
  });

  async function render(strict = false) {
    await act(async () => {
      const page = createElement(ConnectPage, { onConnect, initialServerUrl: serverUrl });
      root.render(strict ? createElement(StrictMode, null, page) : page);
      await Bun.sleep(0);
    });
  }

  function button(label: string): HTMLButtonElement {
    const element = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!element) throw new Error(`Missing button: ${label}`);
    return element;
  }

  async function changeServer(value: string) {
    act(() => button("Advanced…").click());
    const input = container.querySelector("input");
    if (!input) throw new Error("Missing server address");
    const setter = Object.getOwnPropertyDescriptor(
      harness.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("Missing input value setter");
    await act(async () => {
      input.focus();
      setter.call(input, value);
      // React is imported before jsdom by the Bun preload; mirror the shared
      // controlled-input test pattern when its event feature detection is frozen.
      const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
      if (!propsKey) throw new Error("Missing React input props");
      const props = (input as unknown as Record<string, unknown>)[propsKey] as {
        onChange: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
      };
      props.onChange({ target: input, currentTarget: input });
      input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new harness.dom.window.KeyboardEvent("keyup", { bubbles: true }));
      await Bun.sleep(0);
    });
  }

  test.each(["desktop/state", "workspaces"])(
    "times out a stalled %s request and allows a clean retry",
    async (endpoint) => {
      let requestSignal: AbortSignal | null | undefined;
      fetchMock.mockImplementation(async (input, init) => {
        if (!String(input).endsWith(`/cowork/${endpoint}`)) {
          return new Response(null, { status: 404 });
        }
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
            once: true,
          });
        });
      });

      const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>();
      const setTimer = globalThis.setTimeout;
      const clearTimer = globalThis.clearTimeout;
      const setTimerMock = spyOn(globalThis, "setTimeout").mockImplementation(
        (callback, delay, ...args) => {
          const timer = setTimer(callback, delay, ...args);
          if (typeof callback === "function" && delay && delay >= 1000) {
            deadlines.set(timer, () => callback(...args));
          }
          return timer;
        },
      );
      const clearTimerMock = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
        deadlines.delete(timer as ReturnType<typeof setTimeout>);
        clearTimer(timer);
      });
      try {
        await render();
        await act(async () => {
          for (const expire of [...deadlines.values()]) expire();
          await Bun.sleep(0);
        });

        expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/timed out/i);
        expect(requestSignal?.aborted).toBe(true);
        expect(button("Connect").disabled).toBe(false);
        expect(onConnect).not.toHaveBeenCalled();

        fetchMock.mockImplementation(async (input) =>
          String(input).endsWith("/cowork/desktop/state")
            ? new Response(null, { status: 404 })
            : Response.json({ workspaces }),
        );
        await act(async () => {
          button("Connect").click();
          await Bun.sleep(0);
        });
        expect(container.textContent).toContain("Select a workspace:");
        expect(container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        setTimerMock.mockRestore();
        clearTimerMock.mockRestore();
      }
    },
  );

  test("connects a single discovered workspace with one handshake", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith("/cowork/desktop/state")
        ? new Response(null, { status: 404 })
        : Response.json({ workspaces: workspaces.slice(0, 1) }),
    );
    await render();

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith(serverUrl, "/first");
    expect(DiscoveryWebSocket.instances).toHaveLength(1);
  });

  test("clears workspace choices when the server address changes", async () => {
    await render();
    expect(container.textContent).toContain("Select a workspace:");

    await changeServer("ws://127.0.0.1:7444/ws");
    expect(container.textContent).not.toContain("Select a workspace:");
    expect(container.textContent).not.toContain("/first");
    expect(button("Hide advanced").getAttribute("aria-expanded")).toBe("true");
    expect(configure).not.toHaveBeenCalled();

    await act(async () => {
      button("Connect").click();
      await Bun.sleep(0);
    });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      "http://127.0.0.1:7444/cowork/workspaces",
    );
    await act(async () => {
      button("First/first").click();
      await Bun.sleep(0);
    });
    expect(configure).toHaveBeenCalledWith("ws://127.0.0.1:7444/ws", "/first");
  });

  test("does not commit an old server response after editing the address", async () => {
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((complete) => {
      resolve = complete;
    });
    fetchMock.mockImplementation(() => response);
    await render();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;

    await changeServer("ws://127.0.0.1:7444/ws");
    await act(async () => {
      resolve(Response.json({}));
      await Bun.sleep(0);
    });

    expect(configure).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
    expect(button("Connect").disabled).toBe(false);
  });

  test("aborts HTTP discovery and ignores a late response after unmount", async () => {
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((complete) => {
      resolve = complete;
    });
    fetchMock.mockImplementation(() => response);
    await render();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    act(() => root.render(createElement("div")));
    await act(async () => {
      resolve(Response.json({}));
      await Bun.sleep(0);
    });

    expect(configure).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
  });

  test("closes a pending probe when the page unmounts", async () => {
    DiscoveryWebSocket.autoOpen = false;
    await render();
    const socket = DiscoveryWebSocket.instances[0];
    act(() => root.render(createElement("div")));

    expect(socket.closed).toBe(true);
    await act(async () => socket.emit("open"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
  });

  test("allows cancellation while discovery is in progress", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    await render();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading desktop state",
    );

    act(() => button("Cancel").click());
    expect(signal?.aborted).toBe(true);
    expect(button("Connect").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("still connects after StrictMode replays mount effects", async () => {
    fetchMock.mockImplementation(async () => Response.json({}));
    await render(true);

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(DiscoveryWebSocket.instances.every((socket) => socket.closed)).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
