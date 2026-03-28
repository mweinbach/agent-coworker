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
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup() {},
      };
    },
  },
}));

const {
  createRelaySharedKey,
  decodeRelaySecureEnvelope,
  encodeRelaySecureEnvelope,
  generateRelayKeyPair,
  parseRelayControlMessage,
  RELAY_PAIRING_QR_VERSION,
} = await import("../../../src/shared/mobileRelaySecurity");
const { MobileRelayBridge } = await import("../electron/services/mobileRelayBridge");
const MANAGED_RELAY_URL = "wss://api.phodex.app/relay";

type RelaySnapshot = ReturnType<MobileRelayBridge["getSnapshot"]>;
type RelayKeyPair = ReturnType<typeof generateRelayKeyPair>;

async function waitForRelaySnapshot(
  bridge: MobileRelayBridge,
  predicate: (snapshot: RelaySnapshot) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(bridge.getSnapshot())) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for mobile relay snapshot");
}

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

function emitPhoneHandshake(socket: FakeSocket, phoneDeviceId: string, phoneKeys: RelayKeyPair) {
  socket.emitMessage(JSON.stringify({
    kind: "clientHello",
    phoneDeviceId,
    phoneIdentityPublicKey: phoneKeys.publicKeyBase64,
  }));
  socket.emitMessage(JSON.stringify({ kind: "secureReady" }));
}

function findControlMessages(socket: FakeSocket, kind: string): Array<Record<string, unknown>> {
  return socket.sentMessages
    .map((message) => parseRelayControlMessage(message))
    .filter((message): message is NonNullable<ReturnType<typeof parseRelayControlMessage>> => Boolean(message && message.kind === kind))
    .map((message) => message as unknown as Record<string, unknown>);
}

function decodeLastSecureEnvelope(socket: FakeSocket, sharedKey: Uint8Array, lastAcceptedCounter = 0): string | null {
  for (const rawMessage of [...socket.sentMessages].reverse()) {
    const decoded = decodeRelaySecureEnvelope({
      sharedKey,
      rawMessage,
      expectedSender: "mac",
      lastAcceptedCounter,
    });
    if (decoded.ok) {
      return decoded.plaintext;
    }
  }
  return null;
}

describe("mobile relay bridge", () => {
  let remodexStateDir = "";
  let remodexFixture: { macKeyPair: RelayKeyPair; phone1KeyPair: RelayKeyPair };
  let sidecarSocket: FakeSocket;
  let relaySockets: FakeSocket[];

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-mobile-relay-"));
    remodexStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-remodex-state-"));
    sidecarSocket = new FakeSocket();
    relaySockets = [];
    remodexFixture = await writeRemodexState({
      stateDir: remodexStateDir,
    });
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.rm(remodexStateDir, { recursive: true, force: true });
    userDataDir = "";
    remodexStateDir = "";
  });

  test("initial snapshot starts idle from remodex state when available", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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
    expect(snapshot.relaySource).toBe("remodex");
    expect(snapshot.relayServiceStatus).toBe("running");
    expect(snapshot.relayUrl).toBe("wss://api.phodex.app/relay");
    expect(snapshot.sessionId).toBeNull();
    expect(snapshot.pairingPayload).toBeNull();
    expect(snapshot.trustedPhoneDeviceId).toBe("phone-1");
  });

  test("explicit relay override wins over remodex state", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      relayUrl: "wss://override.example.test/relay",
      userDataPath: userDataDir,
      remodexStateDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => sidecarSocket,
      createRelaySocket: () => {
        const socket = new FakeSocket();
        relaySockets.push(socket);
        return socket;
      },
    });

    const snapshot = bridge.getSnapshot();
    expect(snapshot.relaySource).toBe("override");
    expect(snapshot.relayUrl).toBe("wss://override.example.test/relay");
    expect(snapshot.relayServiceStatus).toBe("unknown");
    expect(snapshot.trustedPhoneDeviceId).toBeNull();
  });

  test("initial snapshot falls back to managed state when remodex is missing", async () => {
    await fs.rm(remodexStateDir, { recursive: true, force: true });

    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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
    expect(snapshot.relaySource).toBe("managed");
    expect(snapshot.relayUrl).toBe(MANAGED_RELAY_URL);
    expect(snapshot.relayServiceStatus).toBe("unknown");
    expect(snapshot.relaySourceMessage).toContain("Cowork-managed");
    expect(snapshot.trustedPhoneDeviceId).toBeNull();
  });

  test("start creates a pairing snapshot for the workspace using remodex state", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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
    expect(snapshot.relaySource).toBe("remodex");
    expect(snapshot.relayUrl).toBe("wss://api.phodex.app/relay");
    expect(snapshot.pairingPayload?.sessionId).toBe(snapshot.sessionId);
    expect(snapshot.pairingPayload?.relay).toBe(snapshot.relayUrl);
    expect(snapshot.pairingPayload?.macDeviceId).toBe("mac-1");
    expect(snapshot.pairingPayload?.v).toBe(RELAY_PAIRING_QR_VERSION);
    expect(snapshot.pairingPayload?.macIdentityPublicKey).toBe(remodexFixture.macKeyPair.publicKeyBase64);
    expect(findControlMessages(relaySocket!, "relayMacRegistration")).toHaveLength(1);
  });

  test("rotateSession issues a fresh session id", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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

  test("restart reuses the trusted session id for one-tap reconnects", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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
    emitPhoneHandshake(relaySockets.at(-1)!, "phone-1", remodexFixture.phone1KeyPair);
    await waitForRelaySnapshot(
      bridge,
      (snapshot) => snapshot.status === "connected" && snapshot.trustedPhoneDeviceId === "phone-1",
    );

    await bridge.stop();
    const restarted = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: false,
    });

    expect(restarted.sessionId).toBe(first.sessionId);
    expect(restarted.pairingPayload?.sessionId).toBe(first.sessionId);
  });

  test("rotateSession redirects trusted reconnects from the stale session id", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => {
        queueMicrotask(() => {
          sidecarSocket.open();
        });
        return sidecarSocket;
      },
      createRelaySocket: (url) => {
        const socket = new FakeSocket() as FakeSocket & { relayUrl?: string };
        socket.relayUrl = url;
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
    const firstRelaySocket = relaySockets.at(-1)! as FakeSocket & { relayUrl?: string };

    emitPhoneHandshake(firstRelaySocket, "phone-1", remodexFixture.phone1KeyPair);
    await waitForRelaySnapshot(
      bridge,
      (snapshot) => snapshot.status === "connected" && snapshot.trustedPhoneDeviceId === "phone-1",
    );

    const rotated = await bridge.rotateSession();
    const staleSessionSocket = relaySockets.find((socket) => (
      (socket as FakeSocket & { relayUrl?: string }).relayUrl?.endsWith(`/${first.sessionId}`)
      && socket !== firstRelaySocket
    )) as (FakeSocket & { relayUrl?: string }) | undefined;

    expect(rotated.sessionId).not.toBe(first.sessionId);
    expect(staleSessionSocket).toBeTruthy();

    emitPhoneHandshake(staleSessionSocket!, "phone-1", remodexFixture.phone1KeyPair);

    const redirectedRegistration = findControlMessages(staleSessionSocket!, "relayMacRegistration").at(-1) as
      | { registration?: { sessionId?: string | null } }
      | undefined;
    expect(redirectedRegistration?.registration?.sessionId).toBe(rotated.sessionId);
    const redirectError = findControlMessages(staleSessionSocket!, "secureError").at(-1) as
      | { message?: string }
      | undefined;
    expect(redirectError?.message).toContain("Reconnecting to the latest desktop session");
    expect(staleSessionSocket?.closeCalls).toBeGreaterThan(0);
  });

  test("secure-ready handshake persists the trusted phone summary", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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

    const phoneKeyPair = remodexFixture.phone1KeyPair;
    emitPhoneHandshake(relaySocket!, "phone-1", phoneKeyPair);
    await waitForRelaySnapshot(
      bridge,
      (s) => s.status === "connected" && s.trustedPhoneDeviceId === "phone-1",
    );

    const trusted = bridge.getSnapshot();
    expect(trusted.trustedPhoneDeviceId).toBe("phone-1");
    expect(trusted.trustedPhoneFingerprint).toBeTruthy();
    expect(trusted.status).toBe("connected");

    const remodexDeviceState = JSON.parse(await fs.readFile(path.join(remodexStateDir, "device-state.json"), "utf8"));
    expect(remodexDeviceState.trustedPhones).toEqual(expect.objectContaining({
      "phone-1": phoneKeyPair.publicKeyBase64,
    }));
    expect(findControlMessages(relaySocket!, "secureReady")).toHaveLength(1);

    const forgotten = await bridge.forgetTrustedPhone();
    expect(forgotten.trustedPhoneDeviceId).toBeNull();
    expect(forgotten.trustedPhoneFingerprint).toBeNull();
  });

  test("missing remodex state falls back to managed mode and persists trust in userData", async () => {
    await fs.rm(remodexStateDir, { recursive: true, force: true });

    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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
      yolo: false,
    });
    const relaySocket = relaySockets.at(-1);

    expect(snapshot.relaySource).toBe("managed");
    expect(snapshot.relayUrl).toBe(MANAGED_RELAY_URL);
    expect(snapshot.pairingPayload?.relay).toBe(MANAGED_RELAY_URL);
    expect(snapshot.pairingPayload?.macDeviceId).toBeTruthy();

    const managedPhoneKeyPair = generateRelayKeyPair();
    emitPhoneHandshake(relaySocket!, "phone-managed", managedPhoneKeyPair);
    await waitForRelaySnapshot(
      bridge,
      (s) => s.status === "connected" && s.trustedPhoneDeviceId === "phone-managed",
    );

    const trusted = bridge.getSnapshot();
    expect(trusted.trustedPhoneDeviceId).toBe("phone-managed");
    expect(trusted.status).toBe("connected");

    const managedState = JSON.parse(
      await fs.readFile(path.join(userDataDir, "mobile-relay", "device-state.json"), "utf8"),
    );
    expect(managedState.trustedPhone).toEqual(expect.objectContaining({
      phoneDeviceId: "phone-managed",
      phoneIdentityPublicKey: managedPhoneKeyPair.publicKeyBase64,
    }));
  });

  test("rejects secure-ready before a client hello", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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

    relaySockets.at(-1)?.emitMessage(JSON.stringify({ kind: "secureReady" }));
    await waitForRelaySnapshot(
      bridge,
      (snapshot) => snapshot.status === "error" && Boolean(snapshot.lastError?.includes("handshake is incomplete")),
    );
  });

  test("rejects a different phone when one is already trusted", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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

    const unexpectedPhoneKeyPair = generateRelayKeyPair();
    relaySockets.at(-1)?.emitMessage(JSON.stringify({
      kind: "clientHello",
      phoneDeviceId: "phone-2",
      phoneIdentityPublicKey: unexpectedPhoneKeyPair.publicKeyBase64,
    }));
    await waitForRelaySnapshot(
      bridge,
      (snapshot) => snapshot.status === "error" && Boolean(snapshot.lastError?.includes("already paired with a different phone")),
    );
  });

  test("handles encrypted bridge-level requests over the secure relay", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
      getAppName: () => "Cowork Test",
      getWorkspaceList: () => [{
        id: "ws_1",
        name: "Workspace One",
        path: "/tmp/workspace",
        yolo: false,
      }],
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
    const relaySocket = relaySockets.at(-1)!;
    const phoneKeyPair = remodexFixture.phone1KeyPair;
    emitPhoneHandshake(relaySocket, "phone-1", phoneKeyPair);
    await waitForRelaySnapshot(
      bridge,
      (snapshot) => snapshot.status === "connected",
    );

    const sharedKey = createRelaySharedKey(
      phoneKeyPair.privateKeyBase64,
      remodexFixture.macKeyPair.publicKeyBase64,
    );
    relaySocket.emitMessage(JSON.stringify(encodeRelaySecureEnvelope({
      sharedKey,
      sender: "phone",
      counter: 1,
      plaintext: JSON.stringify({
        id: 7,
        method: "workspace/list",
        params: {},
      }),
    })));

    await waitForRelaySnapshot(bridge, (snapshot) => snapshot.status === "connected");
    const responseText = decodeLastSecureEnvelope(relaySocket, sharedKey);
    expect(responseText).toBeTruthy();
    expect(JSON.parse(responseText ?? "{}")).toEqual({
      id: 7,
      result: {
        workspaces: [{
          id: "ws_1",
          name: "Workspace One",
          path: "/tmp/workspace",
          yolo: false,
        }],
        activeWorkspaceId: "ws_1",
      },
    });
  });

  test("reconnects the relay socket with backoff attempts", async () => {
    const reconnectAttempts: number[] = [];
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
      getAppName: () => "Cowork Test",
      getReconnectDelayMs: (attempt) => {
        reconnectAttempts.push(attempt);
        return 1;
      },
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

    relaySockets[0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reconnectAttempts).toEqual([1]);
    expect(relaySockets).toHaveLength(2);
  });

  test("start closes existing sockets before replacing the bridge session", async () => {
    const sidecarSockets: FakeSocket[] = [];
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
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
      remodexStateDir,
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

  test("invalid remodex state still fails clearly and does not fall back", async () => {
    await fs.rm(path.join(remodexStateDir, "device-state.json"), { force: true });
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      userDataPath: userDataDir,
      remodexStateDir,
      getAppName: () => "Cowork Test",
      createSidecarSocket: () => sidecarSocket,
      createRelaySocket: () => {
        const socket = new FakeSocket();
        relaySockets.push(socket);
        return socket;
      },
    });

    await expect(bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: false,
    })).rejects.toThrow("Remodex device state is missing or unreadable");

    expect(bridge.getSnapshot().relaySource).toBe("remodex");
    expect(bridge.getSnapshot().relayUrl).toBeNull();
    expect(bridge.getSnapshot().status).toBe("error");
  });
});

async function writeRemodexState(options: {
  stateDir: string;
  relayUrl?: string;
  trustedPhones?: Record<string, string>;
  connectionStatus?: string;
  daemonState?: string;
}) {
  const relayUrl = options.relayUrl ?? "wss://api.phodex.app/relay";
  const macKeyPair = generateRelayKeyPair();
  const phone1KeyPair = generateRelayKeyPair();
  const trustedPhones = options.trustedPhones ?? {
    "phone-1": phone1KeyPair.publicKeyBase64,
  };
  await fs.mkdir(options.stateDir, { recursive: true });
  await fs.writeFile(path.join(options.stateDir, "daemon-config.json"), JSON.stringify({
    relayUrl,
  }, null, 2));
  await fs.writeFile(path.join(options.stateDir, "bridge-status.json"), JSON.stringify({
    state: options.daemonState ?? "running",
    connectionStatus: options.connectionStatus ?? "connected",
    lastError: "",
    updatedAt: "2026-03-25T17:00:00.000Z",
  }, null, 2));
  await fs.writeFile(path.join(options.stateDir, "device-state.json"), JSON.stringify({
    version: 1,
    macDeviceId: "mac-1",
    macIdentityPublicKey: macKeyPair.publicKeyBase64,
    macIdentityPrivateKey: macKeyPair.privateKeyBase64,
    trustedPhones,
  }, null, 2));
  await fs.writeFile(path.join(options.stateDir, "pairing-session.json"), JSON.stringify({
    createdAt: "2026-03-25T17:00:00.000Z",
    pairingPayload: {
      v: RELAY_PAIRING_QR_VERSION,
      relay: relayUrl,
      sessionId: "remodex-session",
      macDeviceId: "mac-1",
      macIdentityPublicKey: macKeyPair.publicKeyBase64,
      expiresAt: 1_700_000_000_000,
    },
  }, null, 2));
  return {
    macKeyPair,
    phone1KeyPair,
  };
}
