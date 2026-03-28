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

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
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
  let managedFixture: { macKeyPair: RelayKeyPair; phone1KeyPair: RelayKeyPair };
  let sidecarSocket: FakeSocket;
  let relaySockets: FakeSocket[];

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-mobile-relay-"));
    remodexStateDir = userDataDir;
    sidecarSocket = new FakeSocket();
    relaySockets = [];
    managedFixture = await writeManagedState({
      rootDir: userDataDir,
    });
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
    userDataDir = "";
    remodexStateDir = "";
  });

  test("initial snapshot starts idle from Cowork-managed state", async () => {
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
    expect(snapshot.relaySource).toBe("managed");
    expect(snapshot.relayServiceStatus).toBe("running");
    expect(snapshot.relayUrl).toBe("wss://api.phodex.app/relay");
    expect(snapshot.sessionId).toBeNull();
    expect(snapshot.pairingPayload).toBeNull();
    expect(snapshot.trustedPhoneDeviceId).toBe("phone-1");
  });

  test("explicit relay override keeps Cowork-managed identity state", async () => {
    const bridge = new MobileRelayBridge({
      serverManager: new FakeServerManager() as never,
      relayUrl: "wss://override.example.test/relay",
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
    expect(snapshot.relaySource).toBe("override");
    expect(snapshot.relayUrl).toBe("wss://override.example.test/relay");
    expect(snapshot.relayServiceStatus).toBe("running");
    expect(snapshot.trustedPhoneDeviceId).toBe("phone-1");
  });

  test("initial snapshot creates managed state when none exists", async () => {
    await fs.rm(path.join(userDataDir, "mobile-relay"), { recursive: true, force: true });

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
    expect(snapshot.relaySource).toBe("managed");
    expect(snapshot.relayUrl).toBe(MANAGED_RELAY_URL);
    expect(snapshot.relayServiceStatus).toBe("running");
    expect(snapshot.relaySourceMessage).toContain("Cowork-managed");
    expect(snapshot.trustedPhoneDeviceId).toBeNull();
    const managedState = JSON.parse(
      await fs.readFile(path.join(userDataDir, "mobile-relay", "device-state.json"), "utf8"),
    );
    expect(managedState.macDeviceId).toBeTruthy();
  });

  test("start creates a pairing snapshot for the workspace using Cowork-managed state", async () => {
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
    expect(snapshot.relaySource).toBe("managed");
    expect(snapshot.relayUrl).toBe("wss://api.phodex.app/relay");
    expect(snapshot.pairingPayload?.sessionId).toBe(snapshot.sessionId);
    expect(snapshot.pairingPayload?.relay).toBe(snapshot.relayUrl);
    expect(snapshot.pairingPayload?.macDeviceId).toBe("mac-1");
    expect(snapshot.pairingPayload?.v).toBe(RELAY_PAIRING_QR_VERSION);
    expect(snapshot.pairingPayload?.macIdentityPublicKey).toBe(managedFixture.macKeyPair.publicKeyBase64);
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
    emitPhoneHandshake(relaySockets.at(-1)!, "phone-1", managedFixture.phone1KeyPair);
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

    emitPhoneHandshake(firstRelaySocket, "phone-1", managedFixture.phone1KeyPair);
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

    emitPhoneHandshake(staleSessionSocket!, "phone-1", managedFixture.phone1KeyPair);

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

  test("forgetTrustedPhone revokes the active relay session and starts a fresh unpaired one", async () => {
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
    const relaySocket = relaySockets.at(-1)!;

    const phoneKeyPair = managedFixture.phone1KeyPair;
    emitPhoneHandshake(relaySocket, "phone-1", phoneKeyPair);
    await waitForRelaySnapshot(
      bridge,
      (s) => s.status === "connected" && s.trustedPhoneDeviceId === "phone-1",
    );

    const trusted = bridge.getSnapshot();
    expect(trusted.trustedPhoneDeviceId).toBe("phone-1");
    expect(trusted.trustedPhoneFingerprint).toBeTruthy();
    expect(trusted.status).toBe("connected");

    const managedState = JSON.parse(
      await fs.readFile(path.join(userDataDir, "mobile-relay", "device-state.json"), "utf8"),
    );
    expect(managedState.trustedPhone).toEqual(expect.objectContaining({
      phoneDeviceId: "phone-1",
      phoneIdentityPublicKey: phoneKeyPair.publicKeyBase64,
    }));
    expect(findControlMessages(relaySocket, "secureReady")).toHaveLength(1);

    const sharedKey = createRelaySharedKey(
      phoneKeyPair.privateKeyBase64,
      managedFixture.macKeyPair.publicKeyBase64,
    );

    const forgotten = await bridge.forgetTrustedPhone();
    expect(forgotten.trustedPhoneDeviceId).toBeNull();
    expect(forgotten.trustedPhoneFingerprint).toBeNull();
    expect(forgotten.status).toBe("pairing");
    expect(relaySocket.closeCalls).toBeGreaterThan(0);
    expect(relaySockets).toHaveLength(2);

    relaySocket.emitMessage(JSON.stringify(encodeRelaySecureEnvelope({
      sharedKey,
      sender: "phone",
      counter: 1,
      plaintext: JSON.stringify({
        id: 9,
        method: "workspace/list",
        params: {},
      }),
    })));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sidecarSocket.sentMessages).toHaveLength(0);

    const replacementRelaySocket = relaySockets.at(-1)!;
    const replacementRegistration = findControlMessages(replacementRelaySocket, "relayMacRegistration").at(-1) as
      | { registration?: { trustedPhoneDeviceId?: string | null; trustedPhonePublicKey?: string | null } }
      | undefined;
    expect(replacementRegistration?.registration?.trustedPhoneDeviceId).toBeNull();
    expect(replacementRegistration?.registration?.trustedPhonePublicKey).toBeNull();
  });

  test("forgetTrustedPhone clears the stored Cowork trusted phone record", async () => {
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

    const forgotten = await bridge.forgetTrustedPhone();
    expect(forgotten.trustedPhoneDeviceId).toBeNull();

    const managedState = JSON.parse(
      await fs.readFile(path.join(userDataDir, "mobile-relay", "device-state.json"), "utf8"),
    );
    expect(managedState.trustedPhone).toBeNull();
  });

  test("managed mode persists trust in the Cowork home directory", async () => {
    await fs.rm(path.join(userDataDir, "mobile-relay"), { recursive: true, force: true });

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
    const phoneKeyPair = managedFixture.phone1KeyPair;
    emitPhoneHandshake(relaySocket, "phone-1", phoneKeyPair);
    await waitForRelaySnapshot(
      bridge,
      (snapshot) => snapshot.status === "connected",
    );

    const sharedKey = createRelaySharedKey(
      phoneKeyPair.privateKeyBase64,
      managedFixture.macKeyPair.publicKeyBase64,
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

  test("rejects encrypted application payloads before secure-ready completes", async () => {
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
    const phoneKeyPair = managedFixture.phone1KeyPair;
    relaySocket.emitMessage(JSON.stringify({
      kind: "clientHello",
      phoneDeviceId: "phone-1",
      phoneIdentityPublicKey: phoneKeyPair.publicKeyBase64,
    }));

    const sharedKey = createRelaySharedKey(
      phoneKeyPair.privateKeyBase64,
      managedFixture.macKeyPair.publicKeyBase64,
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

    await waitForRelaySnapshot(
      bridge,
      (snapshot) => snapshot.status === "error" && Boolean(snapshot.lastError?.includes("handshake is incomplete")),
    );

    expect(sidecarSocket.sentMessages).toHaveLength(0);
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

  test("keeps retrying relay reconnects after dial errors", async () => {
    const reconnectAttempts: number[] = [];
    let relayDialCount = 0;
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
        relayDialCount += 1;
        queueMicrotask(() => {
          if (relayDialCount === 2) {
            socket.emitError(new Error("relay dial failed"));
            return;
          }
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
    await waitForCondition(() => relaySockets.length === 3 && (bridge as any).relaySocket === relaySockets[2]);

    expect(reconnectAttempts).toEqual([1, 2]);
    expect(bridge.getSnapshot().lastError).toBe("relay dial failed");
  });

  test("keeps retrying sidecar reconnects after dial errors", async () => {
    const reconnectAttempts: number[] = [];
    const sidecarSockets: FakeSocket[] = [];
    let sidecarDialCount = 0;
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
        const socket = new FakeSocket();
        sidecarSockets.push(socket);
        sidecarDialCount += 1;
        queueMicrotask(() => {
          if (sidecarDialCount === 2) {
            socket.emitError(new Error("sidecar dial failed"));
            return;
          }
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

    sidecarSockets[0]?.close();
    await waitForCondition(() => sidecarSockets.length === 3 && (bridge as any).sidecarSocket === sidecarSockets[2]);

    expect(reconnectAttempts).toEqual([1, 2]);
    expect(bridge.getSnapshot().lastError).toBe("sidecar dial failed");
  });

  test("preserves the current sidecar if a workspace switch dial fails", async () => {
    const sidecarSockets: FakeSocket[] = [];
    const serverManager = {
      async startWorkspaceServer(opts: { workspaceId: string }) {
        return {
          url: opts.workspaceId === "ws_2"
            ? "ws://127.0.0.1:7337/ws-two"
            : "ws://127.0.0.1:7337/ws-one",
        };
      },
    };

    const bridge = new MobileRelayBridge({
      serverManager: serverManager as never,
      userDataPath: userDataDir,
      remodexStateDir,
      getAppName: () => "Cowork Test",
      getWorkspaceList: () => [
        {
          id: "ws_1",
          name: "Workspace One",
          path: "/tmp/workspace-one",
          yolo: false,
        },
        {
          id: "ws_2",
          name: "Workspace Two",
          path: "/tmp/workspace-two",
          yolo: false,
        },
      ],
      createSidecarSocket: (url) => {
        const socket = new FakeSocket();
        sidecarSockets.push(socket);
        queueMicrotask(() => {
          if (url.endsWith("ws-two")) {
            socket.emitError(new Error("switch dial failed"));
            return;
          }
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
      workspacePath: "/tmp/workspace-one",
      yolo: false,
    });

    const originalSidecar = sidecarSockets[0]!;
    await expect((bridge as any).handleWorkspaceSwitch(7, "ws_2")).rejects.toThrow("switch dial failed");

    expect((bridge as any).sidecarSocket).toBe(originalSidecar);
    expect((bridge as any).sidecarUrl).toBe("ws://127.0.0.1:7337/ws-one");
    expect(originalSidecar.closeCalls).toBe(0);
    expect(bridge.getSnapshot().workspaceId).toBe("ws_1");
  });

  test("bounds queued relay payloads while the secure channel is down", async () => {
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

    for (let index = 0; index < 300; index += 1) {
      sidecarSocket.emitMessage(JSON.stringify({
        method: `note/${index}`,
        params: { index },
      }));
    }

    expect((bridge as any).queuedOutboundApplicationMessages).toHaveLength(256);
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

  test("invalid managed state is regenerated instead of failing startup", async () => {
    await fs.mkdir(path.join(userDataDir, "mobile-relay"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "mobile-relay", "device-state.json"), "{bad-json");
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

    expect(snapshot.relaySource).toBe("managed");
    expect(snapshot.relayUrl).toBe(MANAGED_RELAY_URL);
    expect(snapshot.status).toBe("pairing");
    const managedState = JSON.parse(
      await fs.readFile(path.join(userDataDir, "mobile-relay", "device-state.json"), "utf8"),
    );
    expect(managedState.macDeviceId).toBeTruthy();
    expect(managedState.macIdentityPublicKey).toBeTruthy();
  });
});

async function writeManagedState(options: {
  rootDir: string;
  trustedPhoneDeviceId?: string | null;
}) {
  const macKeyPair = generateRelayKeyPair();
  const phone1KeyPair = generateRelayKeyPair();
  const storeDir = path.join(options.rootDir, "mobile-relay");
  const trustedPhoneDeviceId = options.trustedPhoneDeviceId ?? "phone-1";
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, "device-state.json"), JSON.stringify({
    version: 1,
    macDeviceId: "mac-1",
    macIdentityPublicKey: macKeyPair.publicKeyBase64,
    macIdentityPrivateKey: macKeyPair.privateKeyBase64,
    trustedPhone: trustedPhoneDeviceId ? {
      phoneDeviceId: trustedPhoneDeviceId,
      phoneIdentityPublicKey: phone1KeyPair.publicKeyBase64,
      fingerprint: "fingerprint-phone-1",
      displayName: null,
      lastPairedAt: "2026-03-25T17:00:00.000Z",
      lastConnectedAt: "2026-03-25T17:00:00.000Z",
    } : null,
  }, null, 2));
  return {
    macKeyPair,
    phone1KeyPair,
  };
}
