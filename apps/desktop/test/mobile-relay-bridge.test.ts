import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let userDataDir = "";

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : process.cwd()),
    getName: () => "Cowork Test",
  },
}));

const { MobileRelayBridge } = await import("../electron/services/mobileRelayBridge");

class FakeServerManager {
  readonly starts: Array<{ workspaceId: string; workspacePath: string; yolo: boolean }> = [];

  async startWorkspaceServer(opts: { workspaceId: string; workspacePath: string; yolo: boolean }) {
    this.starts.push(opts);
    return { url: "ws://127.0.0.1:7337/ws" };
  }
}

class FakeSocket extends EventEmitter {
  readyState = 0;
  sentMessages: string[] = [];
  closeCalls = 0;

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit("close");
  }

  send(message: string) {
    this.sentMessages.push(message);
  }

  emitMessage(message: string) {
    this.emit("message", message);
  }

  emitError(error: Error) {
    this.emit("error", error);
  }
}

describe("mobile relay bridge", () => {
  let sidecarSocket: FakeSocket;
  let relaySockets: FakeSocket[];

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-mobile-relay-"));
    sidecarSocket = new FakeSocket();
    relaySockets = [];
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
    userDataDir = "";
  });

  test("initial snapshot starts idle with generated device state", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => sidecarSocket,
      createRelaySocket: () => {
        const socket = new FakeSocket();
        relaySockets.push(socket);
        return socket;
      },
    });

    const snapshot = bridge.getSnapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.sessionId).toBeNull();
    expect(snapshot.pairingPayload).toBeNull();
    expect(snapshot.trustedPhoneDeviceId).toBeNull();
  });

  test("start creates a pairing snapshot for the workspace", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => {
        queueMicrotask(() => {
          sidecarSocket.open();
        });
        return sidecarSocket;
      },
      createRelaySocket: () => {
        const socket = new FakeSocket();
        relaySockets.push(socket);
        queueMicrotask(() => {
          socket.open();
        });
        return socket;
      },
    });

    const snapshot = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: true,
    });
    const relaySocket = relaySockets.at(-1);

    expect(snapshot.status).toBe("pairing");
    expect(snapshot.workspaceId).toBe("ws_1");
    expect(snapshot.workspacePath).toBe("/tmp/workspace");
    expect(snapshot.relayUrl).toContain("/relay");
    expect(snapshot.pairingPayload?.sessionId).toBe(snapshot.sessionId);
    expect(snapshot.pairingPayload?.relay).toBe(snapshot.relayUrl);
    expect(relaySocket?.sentMessages.some((message) => message.includes("\"relayMacRegistration\""))).toBe(true);
  });

  test("rotateSession issues a fresh session id", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => {
        queueMicrotask(() => {
          sidecarSocket.open();
        });
        return sidecarSocket;
      },
      createRelaySocket: () => {
        const socket = new FakeSocket();
        relaySockets.push(socket);
        queueMicrotask(() => {
          socket.open();
        });
        return socket;
      },
    });

    const first = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: false,
    });
    const rotated = await bridge.rotateSession();

    expect(rotated.sessionId).not.toBe(first.sessionId);
    expect(rotated.pairingPayload?.sessionId).toBe(rotated.sessionId);
  });

  test("secure-ready handshake persists the trusted phone summary", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => {
        queueMicrotask(() => {
          sidecarSocket.open();
        });
        return sidecarSocket;
      },
      createRelaySocket: () => {
        const socket = new FakeSocket();
        relaySockets.push(socket);
        queueMicrotask(() => {
          socket.open();
        });
        return socket;
      },
    });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: false,
    });
    const relaySocket = relaySockets.at(-1);

    relaySocket?.emitMessage(JSON.stringify({
      kind: "clientHello",
      phoneDeviceId: "phone-1",
      phoneIdentityPublicKey: Buffer.from("phone-public-key").toString("base64"),
    }));
    relaySocket?.emitMessage(JSON.stringify({ kind: "secureReady" }));
    await Promise.resolve();

    const trusted = bridge.getSnapshot();
    expect(trusted.trustedPhoneDeviceId).toBe("phone-1");
    expect(trusted.trustedPhoneFingerprint).toBeTruthy();
    expect(trusted.status).toBe("connected");

    const forgotten = await bridge.forgetTrustedPhone();
    expect(forgotten.trustedPhoneDeviceId).toBeNull();
    expect(forgotten.trustedPhoneFingerprint).toBeNull();
  });

  test("start closes existing sockets before replacing the bridge session", async () => {
    const sidecarSockets: FakeSocket[] = [];
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => {
        const socket = new FakeSocket();
        sidecarSockets.push(socket);
        queueMicrotask(() => {
          socket.open();
        });
        return socket;
      },
      createRelaySocket: () => {
        const socket = new FakeSocket();
        relaySockets.push(socket);
        queueMicrotask(() => {
          socket.open();
        });
        return socket;
      },
    });

    await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: false,
    });

    const firstSidecarSocket = sidecarSockets[0]!;
    const firstRelaySocket = relaySockets[0]!;

    const restarted = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: false,
    });

    expect(sidecarSockets).toHaveLength(2);
    expect(relaySockets).toHaveLength(2);
    expect(firstSidecarSocket.closeCalls).toBeGreaterThanOrEqual(1);
    expect(firstRelaySocket.closeCalls).toBeGreaterThanOrEqual(1);

    firstSidecarSocket.emit("close");
    firstRelaySocket.emit("close");

    expect(bridge.getSnapshot().status).toBe(restarted.status);
    expect(bridge.getSnapshot().sessionId).toBe(restarted.sessionId);
  });

  test("failed relay startup cleans up sockets and leaves an error snapshot", async () => {
    const sidecarSockets: FakeSocket[] = [];
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => {
        const socket = new FakeSocket();
        sidecarSockets.push(socket);
        queueMicrotask(() => {
          socket.open();
        });
        return socket;
      },
      createRelaySocket: () => {
        const socket = new FakeSocket();
        relaySockets.push(socket);
        queueMicrotask(() => {
          socket.emitError(new Error("relay failed"));
        });
        return socket;
      },
    });

    await expect(bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: false,
    })).rejects.toThrow("relay failed");

    expect(bridge.getSnapshot().status).toBe("error");
    expect(bridge.getSnapshot().lastError).toBe("relay failed");
    expect(sidecarSockets[0]?.closeCalls).toBeGreaterThanOrEqual(1);
    expect(relaySockets[0]?.closeCalls).toBeGreaterThanOrEqual(1);
    expect((bridge as any).sidecarSocket).toBeNull();
    expect((bridge as any).relaySocket).toBeNull();
  });
});
