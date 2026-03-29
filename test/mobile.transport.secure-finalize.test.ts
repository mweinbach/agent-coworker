import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter as NodeEventEmitter } from "node:events";

mock.module("expo-modules-core", () => ({
  EventEmitter: class EventEmitter<TEventsMap extends Record<string, (...args: any[]) => void>> {
    private readonly emitter = new NodeEventEmitter();

    addListener<EventName extends keyof TEventsMap>(eventName: EventName, listener: TEventsMap[EventName]) {
      this.emitter.on(String(eventName), listener as (...args: any[]) => void);
      return {
        remove: () => {
          this.emitter.off(String(eventName), listener as (...args: any[]) => void);
        },
      };
    }

    removeAllListeners(eventName: keyof TEventsMap) {
      this.emitter.removeAllListeners(String(eventName));
    }

    emit<EventName extends keyof TEventsMap>(eventName: EventName, ...args: Parameters<TEventsMap[EventName]>) {
      this.emitter.emit(String(eventName), ...args);
    }
  },
  requireOptionalNativeModule: () => null,
}));

const transportModule = await import("../apps/mobile/modules/remodex-secure-transport/src");
const {
  buildRelayHandshakeProofPayload,
  createRelaySharedKey,
  decodeRelaySecureEnvelope,
  encodeRelaySecureEnvelope,
  generateRelayKeyPair,
  RELAY_PAIRING_QR_VERSION,
} = await import("../src/shared/mobileRelaySecurity");

class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  sentMessages: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string | null }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly _protocols?: string | string[],
    readonly _options?: { headers?: Record<string, string> },
  ) {
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  emitMessage(data: string) {
    this.onmessage?.({ data });
  }

  emitError(message: string) {
    this.onerror?.({ message });
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

describe("mobile relay secure finalize", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeSocket.instances = [];
    transportModule.__internal.resetRelayTransportTestState();
    (globalThis as { WebSocket?: typeof globalThis.WebSocket }).WebSocket = FakeSocket as never;
  });

  afterEach(() => {
    (globalThis as { WebSocket?: typeof globalThis.WebSocket }).WebSocket = originalWebSocket;
    transportModule.__internal.resetRelayTransportTestState();
  });

  test("buffers decrypted payloads until secure finalize completes", async () => {
    const macKeyPair = generateRelayKeyPair();
    const relay = new transportModule.__internal.RemodexSecureTransportRelay() as any;
    const plaintextMessages: string[] = [];
    const secureErrors: string[] = [];
    relay.addListener("plaintextMessage", (event: { text: string }) => {
      plaintextMessages.push(event.text);
    });
    relay.addListener("secureError", (event: { message: string }) => {
      secureErrors.push(event.message);
    });

    const finalizeGate = Promise.withResolvers<void>();
    relay.upsertTrustedMacRecord = async (record: unknown) => {
      await finalizeGate.promise;
      return [record];
    };

    const connectPromise = relay.connectFromQr({
      v: RELAY_PAIRING_QR_VERSION,
      relay: "wss://relay.example.test/relay",
      sessionId: "session-1",
      macDeviceId: "mac-1",
      macIdentityPublicKey: macKeyPair.publicKeyBase64,
      pairingSecret: "pairing-secret",
      expiresAt: Date.now() + 60_000,
    });

    await waitForCondition(() => FakeSocket.instances.length === 1);
    const socket = FakeSocket.instances[0]!;
    socket.open();
    await flushMicrotasks();

    const persisted = await relay.readPersistedState();
    const phoneIdentity = persisted.phoneIdentity;
    expect(phoneIdentity).toBeTruthy();

    socket.emitMessage(JSON.stringify({
      kind: "relayMacRegistration",
      registration: {
        sessionId: "session-1",
        macDeviceId: "mac-1",
        macIdentityPublicKey: macKeyPair.publicKeyBase64,
        displayName: "Desktop bridge",
        trustedPhoneDeviceId: null,
        trustedPhonePublicKey: null,
      },
    }));
    await flushMicrotasks();

    const sharedKey = createRelaySharedKey(
      macKeyPair.privateKeyBase64,
      phoneIdentity.phoneIdentityPublicKey,
      "session-1",
    );
    socket.emitMessage(JSON.stringify(encodeRelaySecureEnvelope({
      sharedKey,
      sender: "mac",
      counter: 1,
      plaintext: buildRelayHandshakeProofPayload(),
    })));
    socket.emitMessage(JSON.stringify(encodeRelaySecureEnvelope({
      sharedKey,
      sender: "mac",
      counter: 2,
      plaintext: JSON.stringify({
        id: 7,
        result: {
          workspaces: [],
          activeWorkspaceId: null,
        },
      }),
    })));

    await flushMicrotasks();
    expect(secureErrors).toEqual([]);
    expect((await relay.getState()).status).not.toBe("error");

    finalizeGate.resolve();
    const connectedState = await connectPromise;
    await flushMicrotasks();

    expect(connectedState.status).toBe("connected");
    expect(plaintextMessages).toContain(JSON.stringify({
      id: 7,
      result: {
        workspaces: [],
        activeWorkspaceId: null,
      },
    }));
  });

  test("maps synchronous WebSocket construction failure to error state", async () => {
    class ThrowingWebSocket {
      constructor() {
        throw new Error("Invalid URL");
      }
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = ThrowingWebSocket as never;

    const macKeyPair = generateRelayKeyPair();
    const relay = new transportModule.__internal.RemodexSecureTransportRelay() as any;
    const secureErrors: string[] = [];
    relay.addListener("secureError", (event: { message: string }) => {
      secureErrors.push(event.message);
    });

    const state = await relay.connectFromQr({
      v: RELAY_PAIRING_QR_VERSION,
      relay: "wss://relay.example.test/relay",
      sessionId: "session-ws-throw",
      macDeviceId: "mac-ws-throw",
      macIdentityPublicKey: macKeyPair.publicKeyBase64,
      pairingSecret: "pairing-secret",
      expiresAt: Date.now() + 60_000,
    });

    expect(state.status).toBe("error");
    expect(state.lastError).toBe("Invalid URL");
    expect(secureErrors).toEqual(["Invalid URL"]);
  });

  test("restores replay counters for trusted reconnect after app restart", async () => {
    const macKeyPair = generateRelayKeyPair();
    const relayFirstRun = new transportModule.__internal.RemodexSecureTransportRelay() as any;

    const firstConnectPromise = relayFirstRun.connectFromQr({
      v: RELAY_PAIRING_QR_VERSION,
      relay: "wss://relay.example.test/relay",
      sessionId: "session-replay-restore",
      macDeviceId: "mac-replay",
      macIdentityPublicKey: macKeyPair.publicKeyBase64,
      pairingSecret: "pairing-secret",
      expiresAt: Date.now() + 60_000,
    });

    await waitForCondition(() => FakeSocket.instances.length === 1);
    const firstSocket = FakeSocket.instances[0]!;
    firstSocket.open();
    await flushMicrotasks();

    const firstPersistedState = await relayFirstRun.readPersistedState();
    const firstPhoneIdentity = firstPersistedState.phoneIdentity;
    expect(firstPhoneIdentity).toBeTruthy();

    firstSocket.emitMessage(JSON.stringify({
      kind: "relayMacRegistration",
      registration: {
        sessionId: "session-replay-restore",
        macDeviceId: "mac-replay",
        macIdentityPublicKey: macKeyPair.publicKeyBase64,
        displayName: "Desktop bridge",
        trustedPhoneDeviceId: null,
        trustedPhonePublicKey: null,
      },
    }));
    await flushMicrotasks();

    const sharedKey = createRelaySharedKey(
      macKeyPair.privateKeyBase64,
      firstPhoneIdentity.phoneIdentityPublicKey,
      "session-replay-restore",
    );
    firstSocket.emitMessage(JSON.stringify(encodeRelaySecureEnvelope({
      sharedKey,
      sender: "mac",
      counter: 1,
      plaintext: buildRelayHandshakeProofPayload(),
    })));
    const firstConnectedState = await firstConnectPromise;
    expect(firstConnectedState.status).toBe("connected");

    await relayFirstRun.sendPlaintext(JSON.stringify({
      id: 11,
      method: "workspace/list",
      params: {},
    }));
    await flushMicrotasks(10);

    let trustedRecordBeforeRestart: {
      lastSessionId: string | null;
      lastOutboundCounter: number;
      lastInboundCounter: number;
    } | null = null;
    for (let index = 0; index < 20; index += 1) {
      const persisted = await relayFirstRun.readPersistedState();
      trustedRecordBeforeRestart = persisted.trustedMacs.find((entry: { macDeviceId: string }) => entry.macDeviceId === "mac-replay") ?? null;
      if (trustedRecordBeforeRestart && trustedRecordBeforeRestart.lastOutboundCounter > 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(trustedRecordBeforeRestart).toBeTruthy();
    expect(trustedRecordBeforeRestart!.lastOutboundCounter).toBeGreaterThan(1);

    const relaySecondRun = new transportModule.__internal.RemodexSecureTransportRelay() as any;
    const secondConnectPromise = relaySecondRun.connectTrusted("mac-replay");
    await waitForCondition(() => FakeSocket.instances.length === 2);
    const secondSocket = FakeSocket.instances[1]!;
    secondSocket.open();
    await flushMicrotasks();

    const secondPersistedState = await relaySecondRun.readPersistedState();
    const secondPhoneIdentity = secondPersistedState.phoneIdentity;
    expect(secondPhoneIdentity).toBeTruthy();

    secondSocket.emitMessage(JSON.stringify({
      kind: "relayMacRegistration",
      registration: {
        sessionId: "session-replay-restore",
        macDeviceId: "mac-replay",
        macIdentityPublicKey: macKeyPair.publicKeyBase64,
        displayName: "Desktop bridge",
        trustedPhoneDeviceId: null,
        trustedPhonePublicKey: null,
      },
    }));
    await flushMicrotasks();

    let decodedLastCounter = 0;
    const outboundSecureCounters: number[] = [];
    for (const rawMessage of secondSocket.sentMessages) {
      const decoded = decodeRelaySecureEnvelope({
        sharedKey: createRelaySharedKey(
          macKeyPair.privateKeyBase64,
          secondPhoneIdentity.phoneIdentityPublicKey,
          "session-replay-restore",
        ),
        rawMessage,
        expectedSender: "phone",
        lastAcceptedCounter: decodedLastCounter,
      });
      if (!decoded.ok) {
        continue;
      }
      decodedLastCounter = decoded.envelope.counter;
      outboundSecureCounters.push(decoded.envelope.counter);
    }
    expect(outboundSecureCounters.length).toBeGreaterThan(0);
    expect(outboundSecureCounters[0]!).toBeGreaterThan(trustedRecordBeforeRestart!.lastOutboundCounter);

    secondSocket.emitMessage(JSON.stringify(encodeRelaySecureEnvelope({
      sharedKey: createRelaySharedKey(
        macKeyPair.privateKeyBase64,
        secondPhoneIdentity.phoneIdentityPublicKey,
        "session-replay-restore",
      ),
      sender: "mac",
      counter: trustedRecordBeforeRestart!.lastInboundCounter + 1,
      plaintext: buildRelayHandshakeProofPayload(),
    })));

    const secondConnectedState = await secondConnectPromise;
    expect(secondConnectedState.status).toBe("connected");
  });
});
