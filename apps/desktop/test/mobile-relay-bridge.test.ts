import { describe, expect, mock, test } from "bun:test";
import { MobileRelayBridge } from "../electron/services/mobileRelayBridge";
import type { MobileRelayTrustedPhoneDevice } from "../electron/services/mobileRelayTypes";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTrustedPhone(deviceId: string): MobileRelayTrustedPhoneDevice {
  return {
    deviceId,
    fingerprint: `${deviceId}-fingerprint`,
    displayName: deviceId,
    lastPairedAt: null,
    lastConnectedAt: null,
    permissions: {
      turns: true,
      serverRequests: false,
      providerAuth: false,
      mcpAuth: false,
      workspaceSettings: false,
      backups: false,
      conversations: false,
    },
  };
}

function createServerManagerMock() {
  return {
    startWorkspaceServer: mock(async () => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: {
        url: "https://127.0.0.1:9443",
        port: 9443,
        hostHints: ["127.0.0.1"],
        ticket: "cowork-pair://ticket",
        adminToken: "admin-token",
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        identityPub: "desktop-identity",
        nonce: "nonce-value-123456789012",
        expiresAt: Date.now() + 60_000,
        trustedDevice: null,
        trustedDevices: [],
      },
    })),
    restartWorkspaceServer: mock(async (options?: { mobileH3?: boolean }) => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: options?.mobileH3
        ? {
            url: "https://127.0.0.1:9443",
            port: 9443,
            hostHints: ["127.0.0.1"],
            ticket: "cowork-pair://rotated-ticket",
            adminToken: "admin-token",
            certSha256: "a".repeat(64),
            spkiSha256: "b".repeat(43),
            identityPub: "desktop-identity",
            nonce: "rotated-nonce-value-1234",
            expiresAt: Date.now() + 60_000,
            trustedDevice: null,
            trustedDevices: [],
          }
        : null,
    })),
    listMobileH3TrustedDevices: mock(async () => []),
    revokeMobileH3TrustedDevice: mock(async () => {}),
    revokeMobileH3TrustedDevices: mock(async () => {}),
    updateMobileH3TrustedDevicePermissions: mock(async (_workspaceId, deviceId, permissions) => ({
      deviceId,
      fingerprint: "fingerprint",
      displayName: "Phone",
      lastPairedAt: "2026-05-23T12:00:00.000Z",
      lastConnectedAt: "2026-05-23T12:01:00.000Z",
      permissions: {
        turns: false,
        serverRequests: false,
        providerAuth: false,
        mcpAuth: false,
        workspaceSettings: false,
        backups: false,
        ...permissions,
      },
    })),
  };
}

describe("mobile relay bridge", () => {
  test.each([
    ["permissions", "resolve"],
    ["permissions", "reject"],
    ["revoke", "resolve"],
    ["revoke", "reject"],
    ["revoke-all", "resolve"],
    ["revoke-all", "reject"],
  ] as const)("stops a pending %s request before its late %s", async (action, outcome) => {
    const serverManager = createServerManagerMock();
    const pending = createDeferred<MobileRelayTrustedPhoneDevice>();
    const entered = createDeferred<void>();
    const request: { signal?: AbortSignal } = {};
    const waitForReply = (signal?: AbortSignal) => {
      request.signal = signal;
      entered.resolve();
      // Deliberately ignore abort: Stop must not depend on a remote response.
      return pending.promise;
    };
    serverManager.updateMobileH3TrustedDevicePermissions.mockImplementationOnce(
      (_workspaceId, _deviceId, _permissions, signal?: AbortSignal) => waitForReply(signal),
    );
    serverManager.revokeMobileH3TrustedDevice.mockImplementationOnce(
      async (_workspaceId, _deviceId, signal?: AbortSignal) => {
        await waitForReply(signal);
      },
    );
    serverManager.revokeMobileH3TrustedDevices.mockImplementationOnce(
      async (_workspaceId, signal?: AbortSignal) => {
        await waitForReply(signal);
      },
    );
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
    await bridge.start({ workspaceId: "ws_1", workspacePath: "/workspace", yolo: false });
    const mutation =
      action === "permissions"
        ? bridge.updateTrustedPhonePermissions("old-phone", { turns: true })
        : bridge.forgetTrustedPhone(action === "revoke" ? "old-phone" : undefined);
    await entered.promise;
    const queuedMutation = bridge.updateTrustedPhonePermissions("queued-phone", { turns: false });
    let stoppedBeforeReply = false;
    const stop = bridge.stop().then(() => {
      stoppedBeforeReply = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const restartsBeforeReply = serverManager.restartWorkspaceServer.mock.calls.length;
    const stopped = stoppedBeforeReply;
    const aborted = request.signal?.aborted;
    if (outcome === "resolve") pending.resolve(createTrustedPhone("old-phone"));
    else pending.reject(new Error("late trust request failure"));
    await Promise.all([mutation, queuedMutation, stop]);

    expect(restartsBeforeReply).toBe(1);
    expect(stopped).toBe(true);
    expect(aborted).toBe(true);
    expect(serverManager.updateMobileH3TrustedDevicePermissions).toHaveBeenCalledTimes(
      action === "permissions" ? 1 : 0,
    );
    expect(bridge.getSnapshot()).toMatchObject({
      status: "idle",
      workspaceId: null,
      relayServiceStatus: "not-running",
      trustedPhoneDevices: [],
      lastError: null,
    });
  });

  test("finishes a pending start before disabling its endpoint", async () => {
    const serverManager = createServerManagerMock();
    const listening = await serverManager.startWorkspaceServer();
    serverManager.startWorkspaceServer.mockClear();
    const pending = createDeferred<typeof listening>();
    const entered = createDeferred<void>();
    const calls: string[] = [];
    serverManager.startWorkspaceServer.mockImplementationOnce(async () => {
      calls.push("start");
      entered.resolve();
      const result = await pending.promise;
      calls.push("ready");
      return result;
    });
    serverManager.restartWorkspaceServer.mockImplementationOnce(async () => {
      calls.push("stop");
      return { ...listening, mobileH3: null };
    });
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
    const start = bridge.start({ workspaceId: "ws_1", workspacePath: "/workspace", yolo: false });
    await entered.promise;
    const stop = bridge.stop();
    pending.resolve(listening);
    await Promise.all([start, stop]);

    expect(calls).toEqual(["start", "ready", "stop"]);
    expect(bridge.getSnapshot()).toMatchObject({ status: "idle", workspaceId: null });
    expect(bridge.isActiveForWorkspace("ws_1")).toBe(false);
  });

  test.each(["succeeds", "fails"] as const)(
    "does not restart or republish a pending start that %s after shutdown",
    async (outcome) => {
      const serverManager = createServerManagerMock();
      const listening = await serverManager.startWorkspaceServer();
      serverManager.startWorkspaceServer.mockClear();
      const pending = createDeferred<typeof listening>();
      const entered = createDeferred<void>();
      serverManager.startWorkspaceServer.mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      });
      const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
      const start = bridge.start({ workspaceId: "ws_1", workspacePath: "/workspace", yolo: false });
      await entered.promise;
      bridge.stopForShutdown();
      if (outcome === "succeeds") pending.resolve(listening);
      else pending.reject(new Error("startup cancelled"));
      await start;

      expect(bridge.getSnapshot()).toMatchObject({ status: "idle", workspaceId: null });
      expect(bridge.isActiveForWorkspace("ws_1")).toBe(false);
      expect(serverManager.startWorkspaceServer).toHaveBeenCalledTimes(1);
      expect(serverManager.restartWorkspaceServer).not.toHaveBeenCalled();
    },
  );

  test.each(["succeeds", "fails"] as const)(
    "ignores a trusted-phone refresh that %s after remote access stops",
    async (outcome) => {
      const serverManager = createServerManagerMock();
      const pending = createDeferred<MobileRelayTrustedPhoneDevice[]>();
      serverManager.listMobileH3TrustedDevices.mockImplementationOnce(() => pending.promise);
      const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
      await bridge.start({ workspaceId: "ws_1", workspacePath: "/workspace", yolo: false });
      const refresh = bridge.refreshTrustedPhones();
      await bridge.stop();
      if (outcome === "succeeds") pending.resolve([createTrustedPhone("old-phone")]);
      else pending.reject(new Error("old endpoint stopped"));
      await refresh;

      expect(bridge.getSnapshot()).toMatchObject({
        status: "idle",
        workspaceId: null,
        trustedPhoneDevices: [],
        lastError: null,
      });
    },
  );

  test("does not copy trusted phones from a previous workspace", async () => {
    const serverManager = createServerManagerMock();
    const pending = createDeferred<MobileRelayTrustedPhoneDevice[]>();
    serverManager.listMobileH3TrustedDevices.mockImplementationOnce(() => pending.promise);
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
    await bridge.start({ workspaceId: "ws_1", workspacePath: "/one", yolo: false });
    const refresh = bridge.refreshTrustedPhones();
    await bridge.start({ workspaceId: "ws_2", workspacePath: "/two", yolo: false });
    pending.resolve([createTrustedPhone("old-phone")]);
    await refresh;

    expect(bridge.getSnapshot()).toMatchObject({
      status: "pairing",
      workspaceId: "ws_2",
      trustedPhoneDevices: [],
    });
  });

  test("keeps the most recent trusted-phone refresh when responses arrive out of order", async () => {
    const serverManager = createServerManagerMock();
    const pending = createDeferred<MobileRelayTrustedPhoneDevice[]>();
    serverManager.listMobileH3TrustedDevices.mockImplementationOnce(() => pending.promise);
    serverManager.listMobileH3TrustedDevices.mockImplementationOnce(async () => [
      createTrustedPhone("new-phone"),
    ]);
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
    await bridge.start({ workspaceId: "ws_1", workspacePath: "/workspace", yolo: false });
    const oldRefresh = bridge.refreshTrustedPhones();
    await bridge.refreshTrustedPhones();
    pending.resolve([createTrustedPhone("old-phone")]);
    await oldRefresh;

    expect(bridge.getSnapshot().trustedPhoneDevices.map((device) => device.deviceId)).toEqual([
      "new-phone",
    ]);
  });

  test("finishes a permission update before switching its workspace", async () => {
    const serverManager = createServerManagerMock();
    const pending = createDeferred<MobileRelayTrustedPhoneDevice>();
    const entered = createDeferred<void>();
    const calls: string[] = [];
    serverManager.updateMobileH3TrustedDevicePermissions.mockImplementationOnce(async () => {
      entered.resolve();
      const phone = await pending.promise;
      calls.push("updated");
      return phone;
    });
    const listening = await serverManager.restartWorkspaceServer();
    serverManager.restartWorkspaceServer.mockImplementationOnce(async () => {
      calls.push("switched");
      return listening;
    });
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
    await bridge.start({ workspaceId: "ws_1", workspacePath: "/one", yolo: false });
    const update = bridge.updateTrustedPhonePermissions("old-phone", { turns: true });
    await entered.promise;
    const switchWorkspace = bridge.start({
      workspaceId: "ws_2",
      workspacePath: "/two",
      yolo: false,
    });
    pending.resolve(createTrustedPhone("old-phone"));
    await Promise.all([update, switchWorkspace]);

    expect(calls).toEqual(["updated", "switched"]);
    expect(bridge.getSnapshot()).toMatchObject({
      workspaceId: "ws_2",
      trustedPhoneDevices: [],
    });
  });

  test.each(["rotate", "forget", "permissions"] as const)(
    "does not retarget a queued %s action to another workspace",
    async (action) => {
      const serverManager = createServerManagerMock();
      const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
      await bridge.start({ workspaceId: "ws_1", workspacePath: "/one", yolo: false });

      const switchWorkspace = bridge.start({
        workspaceId: "ws_2",
        workspacePath: "/two",
        yolo: false,
      });
      const mutation =
        action === "rotate"
          ? bridge.rotateSession()
          : action === "forget"
            ? bridge.forgetTrustedPhone("old-phone")
            : bridge.updateTrustedPhonePermissions("old-phone", { turns: true });
      await Promise.all([switchWorkspace, mutation]);

      expect(bridge.getSnapshot()).toMatchObject({
        workspaceId: "ws_2",
        trustedPhoneDevices: [],
      });
      expect(serverManager.restartWorkspaceServer).toHaveBeenCalledTimes(1);
      expect(serverManager.revokeMobileH3TrustedDevice).not.toHaveBeenCalled();
      expect(serverManager.updateMobileH3TrustedDevicePermissions).not.toHaveBeenCalled();
    },
  );

  test("restarts the workspace server without H3 when stopping remote access", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: true,
    });
    const snapshot = await bridge.stop();

    expect(serverManager.restartWorkspaceServer).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: true,
      mobileH3: false,
    });
    expect(snapshot).toMatchObject({
      status: "idle",
      relayServiceStatus: "not-running",
    });
  });

  test("preserves feature flags when starting and stopping mobile H3", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
    const featureFlags = { openAiNativeConnectors: true };

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: true,
      featureFlags,
    });
    await bridge.stop();

    expect(serverManager.startWorkspaceServer).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: true,
      featureFlags,
      mobileH3: true,
    });
    expect(serverManager.restartWorkspaceServer).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: true,
      featureFlags,
      mobileH3: false,
    });
  });

  test("disables the previous workspace H3 endpoint before switching workspaces", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace-one",
      yolo: true,
    });
    await bridge.start({
      workspaceId: "ws_2",
      workspacePath: "/workspace-two",
      yolo: false,
    });

    expect(serverManager.restartWorkspaceServer).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/workspace-one",
      yolo: true,
      mobileH3: false,
    });
    expect(serverManager.startWorkspaceServer).toHaveBeenLastCalledWith({
      workspaceId: "ws_2",
      workspacePath: "/workspace-two",
      yolo: false,
      mobileH3: true,
    });
  });

  test("recovers the previous workspace without H3 when switching workspaces fails", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace-one",
      yolo: true,
    });
    serverManager.restartWorkspaceServer.mockImplementationOnce(async () => {
      throw new Error("previous restart failed");
    });

    const snapshot = await bridge.start({
      workspaceId: "ws_2",
      workspacePath: "/workspace-two",
      yolo: false,
    });
    const afterStop = await bridge.stop();

    expect(serverManager.startWorkspaceServer).toHaveBeenLastCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/workspace-one",
      yolo: true,
      mobileH3: false,
    });
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "ws_1",
      workspacePath: "/workspace-one",
      lastError: "previous restart failed",
    });
    expect(afterStop).toMatchObject({ status: "idle" });
    expect(serverManager.restartWorkspaceServer).toHaveBeenCalledTimes(1);
  });

  test("loads the current trusted phone from the server H3 state", async () => {
    const serverManager = createServerManagerMock();
    serverManager.startWorkspaceServer.mockImplementationOnce(async () => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: {
        url: "https://127.0.0.1:9443",
        port: 9443,
        hostHints: ["127.0.0.1"],
        ticket: "cowork-pair://ticket",
        adminToken: "admin-token",
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        identityPub: "desktop-identity",
        nonce: "nonce-value-123456789012",
        expiresAt: Date.now() + 60_000,
        trustedDevice: {
          deviceId: "phone-1",
          fingerprint: "fingerprint",
          displayName: "Phone",
          lastPairedAt: "2026-05-23T12:00:00.000Z",
          lastConnectedAt: "2026-05-23T12:01:00.000Z",
          permissions: {
            turns: false,
            serverRequests: false,
            providerAuth: false,
            mcpAuth: false,
            workspaceSettings: false,
            backups: false,
          },
        },
        trustedDevices: [
          {
            deviceId: "phone-1",
            fingerprint: "fingerprint",
            displayName: "Phone",
            lastPairedAt: "2026-05-23T12:00:00.000Z",
            lastConnectedAt: "2026-05-23T12:01:00.000Z",
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
      },
    }));
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    const snapshot = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });

    expect(snapshot).toMatchObject({
      status: "connected",
      trustedPhoneDeviceId: "phone-1",
      trustedPhoneFingerprint: "fingerprint",
    });
  });

  test("loads multiple trusted phones and keeps legacy primary fields", async () => {
    const serverManager = createServerManagerMock();
    serverManager.startWorkspaceServer.mockImplementationOnce(async () => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: {
        url: "https://127.0.0.1:9443",
        port: 9443,
        hostHints: ["127.0.0.1"],
        ticket: "cowork-pair://ticket",
        adminToken: "admin-token",
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        identityPub: "desktop-identity",
        nonce: "nonce-value-123456789012",
        expiresAt: Date.now() + 60_000,
        trustedDevice: null,
        trustedDevices: [
          {
            deviceId: "phone-1",
            fingerprint: "fingerprint-1",
            displayName: "Phone 1",
            lastPairedAt: "2026-05-23T12:00:00.000Z",
            lastConnectedAt: "2026-05-23T12:01:00.000Z",
            permissions: {
              turns: true,
              serverRequests: false,
              providerAuth: false,
              mcpAuth: false,
              workspaceSettings: false,
              backups: false,
            },
          },
          {
            deviceId: "phone-2",
            fingerprint: "fingerprint-2",
            displayName: "Phone 2",
            lastPairedAt: "2026-05-23T13:00:00.000Z",
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
      },
    }));
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    const snapshot = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });

    expect(snapshot).toMatchObject({
      status: "connected",
      trustedPhoneDeviceId: "phone-1",
      trustedPhoneFingerprint: "fingerprint-1",
      trustedPhoneDevices: [
        { deviceId: "phone-1", permissions: { turns: true } },
        { deviceId: "phone-2", permissions: { turns: false } },
      ],
    });
  });

  test("updates one trusted phone permission through the workspace server", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });

    const snapshot = await bridge.updateTrustedPhonePermissions("phone-1", {
      turns: true,
    });

    expect(serverManager.updateMobileH3TrustedDevicePermissions).toHaveBeenCalledWith(
      "ws_1",
      "phone-1",
      {
        turns: true,
      },
      expect.any(AbortSignal),
    );
    expect(snapshot).toMatchObject({
      trustedPhoneDevices: [{ deviceId: "phone-1", permissions: { turns: true } }],
      lastError: null,
    });
  });

  test("refreshes externally paired phones from the running workspace server", async () => {
    const serverManager = createServerManagerMock();
    serverManager.listMobileH3TrustedDevices.mockImplementationOnce(async () => [
      {
        deviceId: "phone-1",
        fingerprint: "fingerprint",
        displayName: "Cowork Mobile",
        lastPairedAt: "2026-05-23T12:00:00.000Z",
        lastConnectedAt: "2026-05-23T12:01:00.000Z",
        permissions: {
          turns: false,
          serverRequests: false,
          providerAuth: false,
          mcpAuth: false,
          workspaceSettings: false,
          backups: false,
        },
      },
    ]);
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });
    const snapshot = await bridge.refreshTrustedPhones();

    expect(serverManager.listMobileH3TrustedDevices).toHaveBeenCalledWith("ws_1");
    expect(snapshot).toMatchObject({
      status: "connected",
      trustedPhoneDeviceId: "phone-1",
      trustedPhoneFingerprint: "fingerprint",
      trustedPhoneDevices: [{ displayName: "Cowork Mobile" }],
      lastError: null,
    });
  });

  test("does not track active mobile start options when H3 is unavailable", async () => {
    const serverManager = createServerManagerMock();
    serverManager.startWorkspaceServer.mockImplementationOnce(async () => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: null,
    }));
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    const snapshot = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });
    await bridge.stop();

    expect(snapshot).toMatchObject({
      status: "error",
      lastError: "Workspace server did not return a mobile H3 endpoint.",
    });
    expect(serverManager.restartWorkspaceServer).not.toHaveBeenCalled();
  });

  test("revokes the server trust record before clearing a paired phone", async () => {
    const serverManager = createServerManagerMock();
    serverManager.startWorkspaceServer.mockImplementationOnce(async () => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: {
        url: "https://127.0.0.1:9443",
        port: 9443,
        hostHints: ["127.0.0.1"],
        ticket: "cowork-pair://ticket",
        adminToken: "admin-token",
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        identityPub: "desktop-identity",
        nonce: "nonce-value-123456789012",
        expiresAt: Date.now() + 60_000,
        trustedDevice: {
          deviceId: "phone-1",
          fingerprint: "fingerprint",
          displayName: "Phone",
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
        trustedDevices: [
          {
            deviceId: "phone-1",
            fingerprint: "fingerprint",
            displayName: "Phone",
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
      },
    }));
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });
    (
      bridge as unknown as {
        state: { trustedPhoneDeviceId: string; trustedPhoneFingerprint: string };
      }
    ).state.trustedPhoneDeviceId = "phone-1";
    (
      bridge as unknown as {
        state: { trustedPhoneDeviceId: string; trustedPhoneFingerprint: string };
      }
    ).state.trustedPhoneFingerprint = "fingerprint";

    const snapshot = await bridge.forgetTrustedPhone();

    expect(serverManager.revokeMobileH3TrustedDevice).toHaveBeenCalledWith(
      "ws_1",
      "phone-1",
      expect.any(AbortSignal),
    );
    expect(serverManager.restartWorkspaceServer).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
      mobileH3: true,
      rotateMobileH3Tls: true,
    });
    expect(snapshot).toMatchObject({
      status: "pairing",
      ticketUrl: "cowork-pair://rotated-ticket",
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
      lastError: null,
    });
  });

  test("clears stale forget errors after a successful retry", async () => {
    const serverManager = createServerManagerMock();
    serverManager.startWorkspaceServer.mockImplementationOnce(async () => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: {
        url: "https://127.0.0.1:9443",
        port: 9443,
        hostHints: ["127.0.0.1"],
        ticket: "cowork-pair://ticket",
        adminToken: "admin-token",
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        identityPub: "desktop-identity",
        nonce: "nonce-value-123456789012",
        expiresAt: Date.now() + 60_000,
        trustedDevice: {
          deviceId: "phone-1",
          fingerprint: "fingerprint",
          displayName: "Phone",
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
        trustedDevices: [
          {
            deviceId: "phone-1",
            fingerprint: "fingerprint",
            displayName: "Phone",
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
      },
    }));
    serverManager.revokeMobileH3TrustedDevice.mockImplementationOnce(async () => {
      throw new Error("revoke failed");
    });
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });
    await bridge.forgetTrustedPhone();
    const snapshot = await bridge.forgetTrustedPhone();

    expect(snapshot).toMatchObject({
      status: "pairing",
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
      lastError: null,
    });
  });

  test("revokes all server trust records when the bridge has no paired phone id", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });

    const snapshot = await bridge.forgetTrustedPhone();

    expect(serverManager.revokeMobileH3TrustedDevices).toHaveBeenCalledWith(
      "ws_1",
      expect.any(AbortSignal),
    );
    expect(serverManager.revokeMobileH3TrustedDevice).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
      lastError: null,
    });
  });

  test("recovers the workspace server without H3 when rotation fails", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });
    const featureFlags = { openAiNativeConnectors: true };

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
      featureFlags,
    });
    serverManager.restartWorkspaceServer.mockImplementationOnce(async () => {
      throw new Error("H3 restart failed");
    });

    const snapshot = await bridge.rotateSession();

    expect(serverManager.startWorkspaceServer).toHaveBeenLastCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
      featureFlags,
      mobileH3: false,
    });
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      lastError: "H3 restart failed",
    });

    await bridge.stop();
    expect(serverManager.restartWorkspaceServer).toHaveBeenCalledTimes(1);
  });

  test("clears relay state for shutdown without spawning a replacement server", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });
    const snapshot = bridge.stopForShutdown();

    expect(serverManager.restartWorkspaceServer).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      status: "idle",
      relayServiceStatus: "not-running",
    });
  });

  test("does not restart a workspace server when stopping after a failed start", async () => {
    const serverManager = createServerManagerMock();
    serverManager.startWorkspaceServer.mockImplementationOnce(async () => {
      throw new Error("bind failed");
    });
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });
    const snapshot = await bridge.stop();

    expect(serverManager.restartWorkspaceServer).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      status: "idle",
      relayServiceStatus: "not-running",
    });
  });

  test("recovers the workspace server without H3 when stopping mobile access fails", async () => {
    const serverManager = createServerManagerMock();
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });
    serverManager.restartWorkspaceServer.mockImplementationOnce(async () => {
      throw new Error("restart failed");
    });

    const snapshot = await bridge.stop();

    expect(serverManager.startWorkspaceServer).toHaveBeenLastCalledWith({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
      mobileH3: false,
    });
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      lastError: "restart failed",
    });
  });
});
