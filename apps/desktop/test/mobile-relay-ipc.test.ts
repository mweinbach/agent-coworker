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

  test("throws workspace list errors when cache refresh fails", async () => {
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

      expect(workspaceListProvider).toBeTruthy();
      await expect(workspaceListProvider?.()).rejects.toThrow("Could not load workspace list: disk offline");

      expect(loadState).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[desktop] Failed to refresh mobile relay workspace cache during initial load: disk offline",
      );
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

  test("loads relay configuration before returning mobile relay state", async () => {
    const initialize = mock(() => {});
    const getSnapshot = mock(() => ({
      status: "idle",
      workspaceId: null,
      workspacePath: null,
      relaySource: "managed",
      relaySourceMessage: "loaded",
      relayServiceStatus: "running",
      relayServiceMessage: "running",
      relayServiceUpdatedAt: null,
      relayUrl: "wss://relay.example.test/relay",
      sessionId: null,
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
          initialize,
          start: async () => ({}),
          stop: async () => ({}),
          getSnapshot,
          rotateSession: async () => ({}),
          forgetTrustedPhone: async () => ({}),
        } as never,
      } as never,
      workspaceRoots: {} as never,
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as (_event: unknown, args?: unknown) => Promise<unknown>);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.mobileRelayGetState);
    expect(handler).toBeTruthy();

    await handler?.(null);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  test("invalidates the mobile relay workspace cache after the save-state hook fires", async () => {
    let workspaceListProvider: (() => Promise<Array<{ id: string; name: string; path: string; yolo: boolean }>>) | null = null;
    let invalidateWorkspaceCache: (() => void) | null = null;
    let currentWorkspaces = [{
      id: "ws-1",
      name: "Workspace One",
      path: "/tmp/workspace-one",
      yolo: false,
    }];
    const loadState = mock(async () => ({
      version: 2,
      workspaces: currentWorkspaces,
      threads: [],
    }));

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState } as never,
        mobileRelayBridge: {
          setWorkspaceListProvider(
            provider: () => Promise<Array<{ id: string; name: string; path: string; yolo: boolean }>>,
            invalidator?: () => void
          ) {
            workspaceListProvider = provider;
            if (invalidator) invalidateWorkspaceCache = invalidator;
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
      parseWithSchema(_schema: unknown, value: unknown) {
        return value as never;
      },
    });

    await flushMicrotasks();

    expect(await workspaceListProvider?.()).toEqual([{
      id: "ws-1",
      name: "Workspace One",
      path: "/tmp/workspace-one",
      yolo: false,
    }]);
    expect(loadState).toHaveBeenCalledTimes(1);

    currentWorkspaces = [{
      id: "ws-2",
      name: "Workspace Two",
      path: "/tmp/workspace-two",
      yolo: true,
    }];
    invalidateWorkspaceCache?.();

    expect(await workspaceListProvider?.()).toEqual([{
      id: "ws-2",
      name: "Workspace Two",
      path: "/tmp/workspace-two",
      yolo: true,
    }]);
    expect(loadState).toHaveBeenCalledTimes(2);
  });
});
