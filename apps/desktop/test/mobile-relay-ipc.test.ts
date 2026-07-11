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
      trustedPhoneDevices: [],
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
          refreshTrustedPhones: async () => ({}),
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
      trustedPhoneDevices: [],
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
          refreshTrustedPhones: async () => ({}),
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

  test("updates trusted phone permissions through the relay bridge", async () => {
    const trustedPhoneState = {
      status: "connected",
      workspaceId: "ws_1",
      workspacePath: "/approved/workspace",
      relaySource: "direct",
      relaySourceMessage: "direct",
      relayServiceStatus: "running",
      relayServiceMessage: "running",
      relayServiceUpdatedAt: null,
      relayUrl: "https://127.0.0.1:34443",
      sessionId: null,
      pairingPayload: null,
      trustedPhoneDeviceId: "phone-1",
      trustedPhoneFingerprint: "fingerprint",
      trustedPhoneDevices: [
        {
          deviceId: "phone-1",
          fingerprint: "fingerprint",
          displayName: "Phone",
          lastPairedAt: null,
          lastConnectedAt: null,
          permissions: {
            turns: true,
            serverRequests: false,
            providerAuth: false,
            mcpAuth: false,
            workspaceSettings: false,
            backups: false,
          },
        },
      ],
      directUrl: "https://127.0.0.1:34443",
      ticketUrl: null,
      certSha256: null,
      spkiSha256: null,
      hostHints: ["127.0.0.1"],
      lastError: null,
    } as const;
    const updateTrustedPhonePermissions = mock(async () => trustedPhoneState);
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
          on() {},
          initialize() {},
          start: async () => ({}),
          stop: async () => ({}),
          getSnapshot: () => ({}),
          refreshTrustedPhones: async () => trustedPhoneState,
          rotateSession: async () => ({}),
          forgetTrustedPhone: async () => ({}),
          updateTrustedPhonePermissions,
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

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.mobileRelayUpdateTrustedPhonePermissions);
    expect(handler).toBeTruthy();

    await handler?.(null, {
      workspaceId: "ws_1",
      deviceId: "phone-1",
      permissions: { turns: true },
    });

    expect(updateTrustedPhonePermissions).toHaveBeenCalledWith("phone-1", { turns: true });
  });

  test("forgets only the explicitly scoped workspace device set", async () => {
    const device = (deviceId: string) => ({
      deviceId,
      fingerprint: `fingerprint-${deviceId}`,
      displayName: deviceId,
      lastPairedAt: null,
      lastConnectedAt: null,
      permissions: {
        conversations: false,
        turns: false,
        serverRequests: false,
        providerAuth: false,
        mcpAuth: false,
        workspaceSettings: false,
        backups: false,
      },
    });
    const currentState = {
      status: "connected",
      workspaceId: "ws_1",
      workspacePath: "/approved/workspace",
      relaySource: "direct",
      relaySourceMessage: "direct",
      relayServiceStatus: "running",
      relayServiceMessage: "running",
      relayServiceUpdatedAt: null,
      relayUrl: "https://127.0.0.1:34443",
      sessionId: null,
      pairingPayload: null,
      trustedPhoneDeviceId: "phone-1",
      trustedPhoneFingerprint: "fingerprint-phone-1",
      trustedPhoneDevices: [device("phone-1"), device("phone-2")],
      directUrl: "https://127.0.0.1:34443",
      ticketUrl: null,
      certSha256: null,
      spkiSha256: null,
      hostHints: ["127.0.0.1"],
      lastError: null,
    } as const;
    const forgetTrustedPhone = mock(async (deviceId?: string) => ({
      ...currentState,
      trustedPhoneDeviceId: deviceId === "phone-1" ? "phone-2" : null,
      trustedPhoneFingerprint: deviceId === "phone-1" ? "fingerprint-phone-2" : null,
      trustedPhoneDevices: deviceId === "phone-1" ? [device("phone-2")] : [],
    }));
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
          on() {},
          initialize() {},
          start: async () => ({}),
          stop: async () => ({}),
          getSnapshot: () => currentState,
          refreshTrustedPhones: async () => currentState,
          rotateSession: async () => ({}),
          forgetTrustedPhone,
          updateTrustedPhonePermissions: async () => ({}),
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

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.mobileRelayForgetTrustedPhone);
    expect(handler).toBeTruthy();

    await expect(
      handler?.(null, {
        workspaceId: "ws_2",
        scope: "device",
        deviceId: "phone-1",
      }),
    ).rejects.toThrow("Remote access is active for a different workspace.");
    await expect(
      handler?.(null, {
        workspaceId: "ws_1",
        scope: "all",
        expectedDeviceIds: ["phone-1"],
      }),
    ).rejects.toThrow("The trusted device list changed.");
    expect(forgetTrustedPhone).not.toHaveBeenCalled();

    await expect(
      handler?.(null, {
        workspaceId: "ws_1",
        scope: "device",
        deviceId: "phone-1",
      }),
    ).resolves.toMatchObject({
      trustedPhoneDevices: [expect.objectContaining({ deviceId: "phone-2" })],
    });
    expect(forgetTrustedPhone).toHaveBeenCalledWith("phone-1");
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
          refreshTrustedPhones: async () => ({}),
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
          refreshTrustedPhones: async () => ({}),
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

  test("refreshes trusted phones through the relay bridge", async () => {
    const refreshTrustedPhones = mock(async () => ({
      status: "connected",
      workspaceId: "ws_1",
      workspacePath: "/approved/workspace",
      relaySource: "direct",
      relaySourceMessage: "direct",
      relayServiceStatus: "running",
      relayServiceMessage: "running",
      relayServiceUpdatedAt: null,
      relayUrl: "https://127.0.0.1:34443",
      sessionId: null,
      pairingPayload: null,
      trustedPhoneDeviceId: "phone-1",
      trustedPhoneFingerprint: "fingerprint",
      trustedPhoneDevices: [
        {
          deviceId: "phone-1",
          fingerprint: "fingerprint",
          displayName: "Cowork Mobile",
          lastPairedAt: null,
          lastConnectedAt: null,
          permissions: {
            turns: false,
            serverRequests: false,
            providerAuth: false,
            mcpAuth: false,
            workspaceSettings: false,
            backups: false,
          },
        },
      ],
      directUrl: "https://127.0.0.1:34443",
      ticketUrl: null,
      certSha256: null,
      spkiSha256: null,
      hostHints: ["127.0.0.1"],
      lastError: null,
    }));
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
          on() {},
          initialize() {},
          start: async () => ({}),
          stop: async () => ({}),
          getSnapshot: () => ({}),
          refreshTrustedPhones,
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

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.mobileRelayRefreshTrustedPhones);
    expect(handler).toBeTruthy();

    await expect(handler?.(null)).resolves.toMatchObject({
      status: "connected",
      trustedPhoneDeviceId: "phone-1",
    });
    expect(refreshTrustedPhones).toHaveBeenCalledTimes(1);
  });

  test("unregisters relay state fanout listeners", () => {
    const on = mock((_eventName: string, _listener: (state: unknown) => void) => {});
    const off = mock((_eventName: string, _listener: (state: unknown) => void) => {});
    const handlers = new Map<string, (_event: unknown, args?: unknown) => Promise<unknown>>();

    const unregister = registerMobileRelayIpc({
      deps: {
        persistence: { loadState: async () => ({ workspaces: [] }) } as never,
        mobileRelayBridge: {
          on,
          off,
          initialize() {},
          start: async () => ({}),
          stop: async () => ({}),
          getSnapshot: () => ({}),
          refreshTrustedPhones: async () => ({}),
          rotateSession: async () => ({}),
          forgetTrustedPhone: async () => ({}),
          updateTrustedPhonePermissions: async () => ({}),
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

    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("stateChanged");

    unregister();

    expect(off).toHaveBeenCalledTimes(1);
    expect(off.mock.calls[0]?.[0]).toBe("stateChanged");
    expect(off.mock.calls[0]?.[1]).toBe(on.mock.calls[0]?.[1]);
  });
});
