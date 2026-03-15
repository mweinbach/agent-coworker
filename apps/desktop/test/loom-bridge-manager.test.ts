import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

const { LoomBridgeManager } = await import("../electron/services/loomBridgeManager");

describe("desktop loom bridge manager", () => {
  test("surfaces bridge_state payloads through the cached relay state", () => {
    const states: unknown[] = [];
    const manager = new LoomBridgeManager({
      onStateChange: (state) => {
        states.push(state);
      },
    });

    (manager as any).handleStdoutLine(
      JSON.stringify({
        type: "bridge_state",
        supported: true,
        advertising: true,
        peer: {
          id: "peer-1",
          name: "My iPhone",
          state: "connected",
        },
        localDeviceId: "mac-device-id",
        localDeviceName: "Cowork Mac",
        discoveredPeers: [
          {
            id: "peer-1",
            name: "My iPhone",
            deviceId: "ios-device-id",
          },
        ],
        publishedWorkspaceId: "ws_1",
        publishedWorkspaceName: "Workspace 1",
        openChannelCount: 3,
        lastError: null,
      }),
    );

    expect(states).toHaveLength(1);
    expect(states[0]).toEqual({
      supported: true,
      advertising: true,
      peer: {
        id: "peer-1",
        name: "My iPhone",
        state: "connected",
      },
      localDeviceId: "mac-device-id",
      localDeviceName: "Cowork Mac",
      discoveredPeers: [
        {
          id: "peer-1",
          name: "My iPhone",
          deviceId: "ios-device-id",
        },
      ],
      publishedWorkspaceId: "ws_1",
      publishedWorkspaceName: "Workspace 1",
      openChannelCount: 3,
      lastError: null,
      diagnosticLogs: [],
    });
  });

  test("surfaces bridge_fatal payloads as a stable runtime error", () => {
    const states: Array<{ lastError: string | null }> = [];
    const manager = new LoomBridgeManager({
      onStateChange: (state) => {
        states.push({ lastError: state.lastError });
      },
    });

    (manager as any).handleStdoutLine(
      JSON.stringify({
        type: "bridge_fatal",
        message: "Loom helper crashed",
      }),
    );

    expect(states).toHaveLength(2);
    expect(states[0]).toEqual({
      lastError: process.platform === "darwin" ? null : "iOS Relay is only available on macOS desktop builds.",
    });
    expect(states[1]).toEqual({ lastError: "Loom helper crashed" });
  });

  test("forwards approval requests from the bridge helper", async () => {
    const approvals: Array<{ peerId: string; peerName: string }> = [];
    const manager = new LoomBridgeManager({
      onApprovalRequested: (approval) => {
        approvals.push(approval);
      },
    });

    (manager as any).handleStdoutLine(
      JSON.stringify({
        type: "bridge_approval_requested",
        approval: {
          peerId: "peer-1",
          peerName: "My iPhone",
        },
      }),
    );

    await Promise.resolve();
    expect(approvals).toEqual([
      {
        peerId: "peer-1",
        peerName: "My iPhone",
      },
    ]);
  });
});
