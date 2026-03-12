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
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function createManualTimers() {
  const timeoutCallbacks: Array<() => void> = [];
  const intervalCallbacks: Array<() => void> = [];
  const clearedTimeouts: unknown[] = [];
  const clearedIntervals: unknown[] = [];

  return {
    timeoutCallbacks,
    intervalCallbacks,
    clearedTimeouts,
    clearedIntervals,
    scheduler: {
      setTimeout(callback: () => void) {
        timeoutCallbacks.push(callback);
        return { kind: "timeout", id: timeoutCallbacks.length };
      },
      clearTimeout(handle: unknown) {
        clearedTimeouts.push(handle);
      },
      setInterval(callback: () => void) {
        intervalCallbacks.push(callback);
        return { kind: "interval", id: intervalCallbacks.length };
      },
      clearInterval(handle: unknown) {
        clearedIntervals.push(handle);
      },
    },
  };
}

function parseSentMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

describe("AgentSocket runtime dispatch", () => {
  test.serial("reports invalid socket envelopes without invoking onEvent", async () => {
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

  test.serial("does not swallow onEvent exceptions as invalid_envelope", async () => {
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

  test.serial("reconnects with resumeSessionId and flushes queued messages only after server_hello", async () => {
    FakeWebSocket.instances = [];
    const timers = createManualTimers();
    const onClose: string[] = [];

    const socket = new AgentSocket({
      url: "ws://example.test/socket",
      client: "test-client",
      WebSocketImpl: FakeWebSocket as any,
      autoReconnect: true,
      pingIntervalMs: 0,
      timers: timers.scheduler,
      onEvent: () => {},
      onClose: (reason) => onClose.push(reason),
    });

    socket.connect();
    await flushMicrotasks();

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
    expect(timers.timeoutCallbacks).toHaveLength(1);
    expect(onClose).toHaveLength(0);

    expect(
      socket.send({ type: "user_message", sessionId: "sess-1", text: "retry me" }),
    ).toBe(true);

    timers.timeoutCallbacks[0]!();
    await flushMicrotasks();

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
  });

  test.serial("sends keepalive pings only after a session is established", async () => {
    FakeWebSocket.instances = [];
    const timers = createManualTimers();

    const socket = new AgentSocket({
      url: "ws://example.test/socket",
      client: "test-client",
      WebSocketImpl: FakeWebSocket as any,
      pingIntervalMs: 1000,
      timers: timers.scheduler,
      onEvent: () => {},
    });

    socket.connect();
    await flushMicrotasks();

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(timers.intervalCallbacks).toHaveLength(1);

    timers.intervalCallbacks[0]!();
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

    timers.intervalCallbacks[0]!();
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
    expect(timers.clearedIntervals).not.toHaveLength(0);
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

  test.serial("queues user messages until server_hello flushes them", async () => {
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

    await flushMicrotasks();

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
