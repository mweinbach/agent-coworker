import { afterEach, describe, expect, mock, test } from "bun:test";
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

const transportModule = await import("../app/mobile/modules/remodex-secure-transport/src");
const { CoworkJsonRpcClient } = await import("../app/mobile/src/features/cowork/jsonRpcClient");

type RemodexQrPairingPayload = transportModule.RemodexQrPairingPayload;

function createPayload(): RemodexQrPairingPayload {
  return {
    v: 2,
    relay: "wss://relay.example.test/relay",
    sessionId: "session-demo",
    macDeviceId: "mac-demo",
    macIdentityPublicKey: "bWFjLXB1YmxpYy1rZXk=",
    expiresAt: Date.now() + 60_000,
  };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

describe("mobile transport integration", () => {
  afterEach(async () => {
    await transportModule.disconnectTransport();
  });

  test("fallback secure transport can initialize, list, read, and run a turn", async () => {
    const payload = createPayload();
    const sent: string[] = [];
    const notifications: string[] = [];

    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile-test",
        version: "0.1.0",
      },
      send: async (text) => {
        sent.push(text);
        await transportModule.sendPlaintext(text);
      },
      onNotification(notification) {
        notifications.push(notification.method);
      },
    });

    const subscription = transportModule.addRemodexListener("plaintextMessage", (event) => {
      void client.handleIncoming(event.text);
    });

    try {
      await transportModule.connectFromQr(payload);
      await client.initialize();

      const threadList = await client.requestThreadList();
      expect(threadList.threads).toHaveLength(1);
      expect(threadList.threads[0]?.title).toContain("Remote Access Demo");

      const threadId = threadList.threads[0]!.id;
      const threadRead = await client.readThread(threadId);
      expect(threadRead.coworkSnapshot?.feed.length).toBeGreaterThanOrEqual(2);

      await client.startTurn(threadId, "Hello from mobile");
      await flushMicrotasks();

      const reread = await client.readThread(threadId);
      const feed = reread.coworkSnapshot?.feed ?? [];
      expect(feed.some((item) => item.kind === "message" && item.role === "user" && item.text.includes("Hello from mobile"))).toBe(true);
      expect(feed.some((item) => item.kind === "message" && item.role === "assistant" && item.text.includes("Mock remote reply"))).toBe(true);
      expect(notifications).toEqual(expect.arrayContaining([
        "thread/started",
        "turn/started",
        "item/started",
        "item/agentMessage/delta",
        "item/completed",
        "turn/completed",
      ]));

      await client.interruptTurn(threadId);
      await flushMicrotasks();
      const interrupted = await client.readThread(threadId);
      expect(interrupted.coworkSnapshot?.feed.some((item) => item.kind === "system" && item.line.includes("Interrupt requested"))).toBe(true);
      expect(sent.some((entry) => entry.includes("\"turn/start\""))).toBe(true);
    } finally {
      subscription.remove();
    }
  });

  test("fallback secure transport can round-trip an approval server request", async () => {
    const payload = createPayload();
    const requests: string[] = [];

    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile-test",
        version: "0.1.0",
      },
      send: async (text) => {
        await transportModule.sendPlaintext(text);
      },
      onServerRequest(request) {
        requests.push(request.method);
        void client.respondServerRequest(request.id, { decision: "accept" });
      },
    });

    const subscription = transportModule.addRemodexListener("plaintextMessage", (event) => {
      void client.handleIncoming(event.text);
    });

    try {
      await transportModule.connectFromQr(payload);
      await client.initialize();

      const threadList = await client.requestThreadList();
      const threadId = threadList.threads[0]!.id;

      await client.startTurn(threadId, "Please trigger approval");
      await flushMicrotasks();
      await flushMicrotasks();

      expect(requests).toContain("item/commandExecution/requestApproval");

      const reread = await client.readThread(threadId);
      expect(
        reread.coworkSnapshot?.feed.some(
          (item) =>
            item.kind === "message" &&
            item.role === "assistant" &&
            item.text.includes("Approval accepted"),
        ),
      ).toBe(true);
    } finally {
      subscription.remove();
    }
  });

  test("fallback secure transport can round-trip a user-input server request", async () => {
    const payload = createPayload();
    const requests: string[] = [];

    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile-test",
        version: "0.1.0",
      },
      send: async (text) => {
        await transportModule.sendPlaintext(text);
      },
      onServerRequest(message) {
        requests.push(message.method);
        if (message.method === "item/tool/requestUserInput") {
          void client.respondServerRequest(message.id, { answer: "continue" });
        }
      },
    });

    const subscription = transportModule.addRemodexListener("plaintextMessage", (event) => {
      void client.handleIncoming(event.text);
    });

    try {
      await transportModule.connectFromQr(payload);
      await client.initialize();
      const threadId = (await client.requestThreadList()).threads[0]!.id;

      await client.startTurn(threadId, "Please trigger input");
      await flushMicrotasks(8);

      expect(requests).toContain("item/tool/requestUserInput");

      const reread = await client.readThread(threadId);
      expect(
        reread.coworkSnapshot?.feed.some(
          (item) =>
            item.kind === "message" &&
            item.role === "assistant" &&
            item.text.includes("continue"),
        ),
      ).toBe(true);
    } finally {
      subscription.remove();
    }
  });
});
