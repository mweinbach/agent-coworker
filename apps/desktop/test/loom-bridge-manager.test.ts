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
        publishedWorkspaceId: "ws_1",
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
      publishedWorkspaceId: "ws_1",
      openChannelCount: 3,
      lastError: null,
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

    expect(states).toEqual([{ lastError: "Loom helper crashed" }]);
  });
});
