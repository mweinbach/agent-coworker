import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

const getAllWindowsMock = mock(() => []);
const electronMockOverrides = {
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
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { registerMobileRelayIpc } = await import("../electron/ipc/mobileRelay");

describe("mobile relay IPC", () => {
  beforeEach(() => {
    process.env.COWORK_ENABLE_REMOTE_ACCESS = "1";
    setElectronMockOverrides(electronMockOverrides);
  });

  afterEach(() => {
    getAllWindowsMock.mockClear();
    delete process.env.COWORK_ENABLE_REMOTE_ACCESS;
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
      directUrl: null,
      ticketUrl: null,
      certSha256: null,
      spkiSha256: null,
      hostHints: [],
      lastError: null,
    }));
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
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
      directUrl: null,
      ticketUrl: null,
      certSha256: null,
      spkiSha256: null,
      hostHints: [],
      lastError: null,
    }));
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
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

  test("returns an unavailable state when remote access is disabled", async () => {
    process.env.COWORK_ENABLE_REMOTE_ACCESS = "0";
    const initialize = mock(() => {});
    const stop = mock(async () => ({}));
    const getSnapshot = mock(() => ({}));
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
          on() {},
          initialize,
          start: async () => ({}),
          stop,
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

    await expect(handler?.(null)).resolves.toMatchObject({
      status: "idle",
      relaySource: "unavailable",
      relayServiceStatus: "unavailable",
      directUrl: null,
      ticketUrl: null,
      certSha256: null,
      spkiSha256: null,
      hostHints: [],
      lastError: "Remote access is disabled.",
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(initialize).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  test("rejects remote access start when the feature is disabled", async () => {
    process.env.COWORK_ENABLE_REMOTE_ACCESS = "0";
    const start = mock(async () => ({}));
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
          on() {},
          start,
          stop: async () => ({}),
          getSnapshot: () => ({}),
          rotateSession: async () => ({}),
          forgetTrustedPhone: async () => ({}),
        } as never,
      } as never,
      workspaceRoots: {
        assertApprovedWorkspacePath: async (workspacePath: string) => workspacePath,
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

    await expect(
      handler?.(null, {
        workspaceId: "ws_1",
        workspacePath: "/tmp/workspace",
        yolo: false,
      }),
    ).rejects.toThrow("Remote access is disabled.");
    expect(start).not.toHaveBeenCalled();
  });
});
