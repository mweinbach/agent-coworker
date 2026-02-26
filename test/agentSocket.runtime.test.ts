import { describe, expect, test } from "bun:test";

import { AgentSocket, type InvalidServerEvent } from "../src/client/agentSocket";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onmessage: null | ((ev: { data: unknown }) => void | Promise<void>) = null;
  onclose: null | (() => void) = null;

  constructor(_url: string) {
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
});
