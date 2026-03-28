import { afterEach, describe, expect, mock, test } from "bun:test";

import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";

const getAllWindowsMock = mock(() => []);

mock.module("electron", () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getName: () => "Cowork Test",
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup() {},
      };
    },
  },
}));

const { registerMobileRelayIpc } = await import("../electron/ipc/mobileRelay");

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("mobile relay IPC", () => {
  afterEach(() => {
    getAllWindowsMock.mockClear();
  });

  test("logs workspace cache refresh failures instead of swallowing them", async () => {
    let workspaceListProvider: (() => Promise<unknown[]>) | null = null;
    const loadState = mock(async () => {
      throw new Error("disk offline");
    });
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      registerMobileRelayIpc({
        deps: {
          persistence: { loadState } as never,
          mobileRelayBridge: {
            setWorkspaceListProvider(provider: () => Promise<unknown[]>) {
              workspaceListProvider = provider;
            },
            on() {},
            start: async () => ({}),
            stop: async () => ({}),
            getSnapshot: () => ({}),
            rotateSession: async () => ({}),
            forgetTrustedPhone: async () => ({}),
          } as never,
        } as never,
        workspaceRoots: {} as never,
        handleDesktopInvoke() {},
        parseWithSchema(_schema, value) {
          return value as never;
        },
      });

      await flushMicrotasks();

      const result = await workspaceListProvider?.();

      expect(loadState).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[desktop] Failed to refresh mobile relay workspace cache during initial load: disk offline",
      );
      expect(result).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("validates the mobile relay workspace path against approved roots", async () => {
    const assertApprovedWorkspacePath = mock(async () => "/approved/workspace");
    const start = mock(async () => ({
      status: "pairing",
      workspaceId: "ws_1",
      workspacePath: "/approved/workspace",
      relaySource: "managed",
      relaySourceMessage: "managed",
      relayServiceStatus: "running",
      relayServiceMessage: "running",
      relayServiceUpdatedAt: null,
      relayUrl: "wss://relay.example.test/relay",
      sessionId: "session-1",
      pairingPayload: null,
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
      lastError: null,
    }));
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
          setWorkspaceListProvider() {},
          on() {},
          start,
          stop: async () => ({}),
          getSnapshot: () => ({}),
          rotateSession: async () => ({}),
          forgetTrustedPhone: async () => ({}),
        } as never,
      } as never,
      workspaceRoots: {
        assertApprovedWorkspacePath,
      } as never,
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as (_event: unknown, args?: unknown) => Promise<unknown>);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.mobileRelayStart);
    expect(handler).toBeTruthy();

    await handler?.(null, {
      workspaceId: "ws_1",
      workspacePath: "/tmp/unapproved",
      yolo: false,
    });

    expect(assertApprovedWorkspacePath).toHaveBeenCalledWith("/tmp/unapproved");
    expect(start).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/approved/workspace",
      yolo: false,
    });
  });
});
