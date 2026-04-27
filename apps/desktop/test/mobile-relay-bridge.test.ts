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
      },
    })),
    restartWorkspaceServer: mock(async () => ({
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: null,
    })),
    revokeMobileH3TrustedDevice: mock(async () => {}),
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
});
