import { describe, expect, test } from "bun:test";

import { AgentSocket, type InvalidServerEvent } from "../src/client/agentSocket";
import type { ServerEvent } from "../src/server/protocol";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onmessage: null | ((ev: { data: unknown }) => void | Promise<void>) = null;
  onclose: null | (() => void) = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  async emitMessage(data: unknown) {
    if (!this.onmessage) throw new Error("onmessage handler is not set");
    await this.onmessage({ data });
  }
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function parseSentMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

describe("AgentSocket runtime dispatch", () => {
  test("reports invalid socket envelopes without invoking onEvent", async () => {
    FakeWebSocket.instances = [];
    const invalid: InvalidServerEvent[] = [];
    const received: string[] = [];

    const socket = new AgentSocket({
      url: "ws://example.test/socket",
      client: "test-client",
      WebSocketImpl: FakeWebSocket as any,
      pingIntervalMs: 0,
      onEvent: (evt) => received.push(evt.type),
      onInvalidEvent: (evt) => invalid.push(evt),
    });

    socket.connect();
    await flushMicrotasks();

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    await ws!.emitMessage("{not-json");

    expect(received).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.reason).toBe("invalid_json");
  });

  test("does not swallow onEvent exceptions as invalid_envelope", async () => {
    FakeWebSocket.instances = [];
    const invalid: InvalidServerEvent[] = [];
    const consumerError = new Error("consumer handler exploded");

    const socket = new AgentSocket({
      url: "ws://example.test/socket",
      client: "test-client",
      WebSocketImpl: FakeWebSocket as any,
      pingIntervalMs: 0,
      onEvent: () => {
        throw consumerError;
      },
      onInvalidEvent: (evt) => invalid.push(evt),
    });

    socket.connect();
    await flushMicrotasks();

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();

    await expect(
      ws!.emitMessage(
        JSON.stringify({
          type: "server_hello",
          sessionId: "sess-1",
          config: {
            provider: "openai",
            model: "gpt-test",
            workingDirectory: "/tmp",
          },
        })
      )
    ).rejects.toThrow("consumer handler exploded");

    expect(invalid).toHaveLength(0);
  });

  test("reconnects with resumeSessionId and flushes queued messages only after server_hello", async () => {
    FakeWebSocket.instances = [];
    const scheduledReconnects: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const onClose: string[] = [];
    const waitForSocketOpen = () => new Promise<void>((resolve) => originalSetTimeout(resolve, 0));

    (globalThis as typeof globalThis & {
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    }).setTimeout = ((callback: TimerHandler) => {
      scheduledReconnects.push(callback as () => void);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    (globalThis as typeof globalThis & {
      clearTimeout: typeof clearTimeout;
    }).clearTimeout = ((_timer: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout;

    try {
      const socket = new AgentSocket({
        url: "ws://example.test/socket",
        client: "test-client",
        WebSocketImpl: FakeWebSocket as any,
        autoReconnect: true,
        pingIntervalMs: 0,
        onEvent: () => {},
        onClose: (reason) => onClose.push(reason),
      });

      socket.connect();
      await waitForSocketOpen();

      const ws1 = FakeWebSocket.instances[0];
      expect(ws1).toBeDefined();
      await ws1!.emitMessage(
        JSON.stringify({
          type: "server_hello",
          sessionId: "sess-1",
          config: {
            provider: "openai",
            model: "gpt-test",
            workingDirectory: "/tmp",
          },
        }),
      );

      ws1!.close();
      expect(scheduledReconnects).toHaveLength(1);
      expect(onClose).toHaveLength(0);

      expect(
        socket.send({ type: "user_message", sessionId: "sess-1", text: "retry me" }),
      ).toBe(true);

      scheduledReconnects[0]!();
      await waitForSocketOpen();

      const ws2 = FakeWebSocket.instances[1];
      expect(ws2).toBeDefined();
      expect(ws2!.url).toContain("resumeSessionId=sess-1");
      expect(parseSentMessages(ws2!)).toEqual([
        {
          type: "client_hello",
          client: "test-client",
        },
      ]);

      await ws2!.emitMessage(
        JSON.stringify({
          type: "server_hello",
          sessionId: "sess-1",
          config: {
            provider: "openai",
            model: "gpt-test",
            workingDirectory: "/tmp",
          },
        }),
      );

      expect(parseSentMessages(ws2!)).toEqual([
        {
          type: "client_hello",
          client: "test-client",
        },
        {
          type: "user_message",
          sessionId: "sess-1",
          text: "retry me",
        },
      ]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("sends keepalive pings only after a session is established", async () => {
    FakeWebSocket.instances = [];
    const pingCallbacks: Array<() => void> = [];
    const clearedIntervals: number[] = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;

    (globalThis as typeof globalThis & {
      setInterval: typeof setInterval;
      clearInterval: typeof clearInterval;
    }).setInterval = ((callback: TimerHandler) => {
      pingCallbacks.push(callback as () => void);
      return pingCallbacks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as typeof globalThis & {
      clearInterval: typeof clearInterval;
    }).clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      clearedIntervals.push(timer as unknown as number);
    }) as typeof clearInterval;

    try {
      const socket = new AgentSocket({
        url: "ws://example.test/socket",
        client: "test-client",
        WebSocketImpl: FakeWebSocket as any,
        pingIntervalMs: 1000,
        onEvent: () => {},
      });

      socket.connect();
      await flushMicrotasks();

      const ws = FakeWebSocket.instances[0];
      expect(ws).toBeDefined();
      expect(pingCallbacks).toHaveLength(1);

      pingCallbacks[0]!();
      expect(parseSentMessages(ws!)).toEqual([
        {
          type: "client_hello",
          client: "test-client",
        },
      ]);

      await ws!.emitMessage(
        JSON.stringify({
          type: "server_hello",
          sessionId: "sess-keepalive",
          config: {
            provider: "openai",
            model: "gpt-test",
            workingDirectory: "/tmp",
          },
        }),
      );

      pingCallbacks[0]!();
      expect(parseSentMessages(ws!)).toEqual([
        {
          type: "client_hello",
          client: "test-client",
        },
        {
          type: "ping",
          sessionId: "sess-keepalive",
        },
      ]);

      socket.close();
      expect(clearedIntervals).not.toHaveLength(0);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});

describe("AgentSocket reconnect queue", () => {
  class DelayedOpenWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: DelayedOpenWebSocket[] = [];

    readyState = DelayedOpenWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: null | (() => void) = null;
    onmessage: null | ((ev: { data: unknown }) => void | Promise<void>) = null;
    onerror: null | (() => void) = null;
    onclose: null | (() => void) = null;

    constructor(_url: string) {
      DelayedOpenWebSocket.instances.push(this);
    }

    triggerOpen() {
      this.readyState = DelayedOpenWebSocket.OPEN;
      this.onopen?.();
    }

    send(data: string) {
      this.sent.push(String(data));
    }

    async emitMessage(data: unknown) {
      if (!this.onmessage) throw new Error("no message handler");
      await this.onmessage({ data });
    }

    close() {
      this.readyState = DelayedOpenWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  test("queues user messages until server_hello flushes them", async () => {
    DelayedOpenWebSocket.instances = [];
    const socket = new AgentSocket({
      url: "ws://example.test/socket",
      client: "test-client",
      WebSocketImpl: DelayedOpenWebSocket as any,
      pingIntervalMs: 0,
      autoReconnect: true,
      onEvent: () => {},
    });

    socket.connect();
    const ws = DelayedOpenWebSocket.instances[0];
    expect(ws).toBeDefined();

    const sendAccepted = socket.send({ type: "user_message", text: "queued" } as any);
    expect(sendAccepted).toBe(true);
    expect(ws?.sent).toHaveLength(0);

    ws?.triggerOpen();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const hello: ServerEvent = {
      type: "server_hello",
      sessionId: "session-queue",
      config: {
        provider: "openai",
        model: "gpt-test",
        workingDirectory: "/tmp",
        outputDirectory: "/tmp/output",
      },
    };
    await ws?.emitMessage(JSON.stringify(hello));

    const userMessages = ws?.sent
      .map((raw) => {
        try {
          return JSON.parse(raw)?.type;
        } catch {
          return null;
        }
      })
      .filter((type) => type === "user_message");

    expect(userMessages?.length).toBe(1);
  });
});
