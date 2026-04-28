import { describe, expect, mock, test } from "bun:test";
import { MobileRelayBridge } from "../electron/services/mobileRelayBridge";

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
      },
    })),
    restartWorkspaceServer: mock(async () => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: null,
    })),
    revokeMobileH3TrustedDevice: mock(async () => {}),
    revokeMobileH3TrustedDevices: mock(async () => {}),
  };
}

describe("mobile relay bridge", () => {
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
        },
      },
    }));
    const bridge = new MobileRelayBridge({ serverManager: serverManager as never });

    const snapshot = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });

    expect(snapshot).toMatchObject({
      trustedPhoneDeviceId: "phone-1",
      trustedPhoneFingerprint: "fingerprint",
    });
  });

  test("revokes the server trust record before clearing a paired phone", async () => {
    const serverManager = createServerManagerMock();
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

    expect(serverManager.revokeMobileH3TrustedDevice).toHaveBeenCalledWith("ws_1", "phone-1");
    expect(snapshot).toMatchObject({
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

    expect(serverManager.revokeMobileH3TrustedDevices).toHaveBeenCalledWith("ws_1");
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
