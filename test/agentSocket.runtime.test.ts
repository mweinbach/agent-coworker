import { describe, expect, test } from "bun:test";

import { AgentSocket, type InvalidServerEvent } from "../src/client/agentSocket";
import type { ServerEvent } from "../src/server/protocol";
import { createFailureDiagnostics } from "./shared/failureDiagnostics";

type FailureDiagnostics = ReturnType<typeof createFailureDiagnostics>;

let activeDiagnostics: FailureDiagnostics | null = null;

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
    activeDiagnostics?.log("fake-socket.construct", {
      url,
      instanceCount: FakeWebSocket.instances.length,
    });
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      activeDiagnostics?.log("fake-socket.open", {
        url: this.url,
        readyState: this.readyState,
      });
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(String(data));
    activeDiagnostics?.log("fake-socket.send", {
      url: this.url,
      readyState: this.readyState,
      data,
    });
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    activeDiagnostics?.log("fake-socket.close", {
      url: this.url,
      readyState: this.readyState,
    });
    this.onclose?.();
  }

  async emitMessage(data: unknown) {
    if (!this.onmessage) throw new Error("onmessage handler is not set");
    activeDiagnostics?.log("fake-socket.emit-message", {
      url: this.url,
      data,
    });
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
        activeDiagnostics?.log("manual-timer.set-timeout", {
          callbackCount: timeoutCallbacks.length,
        });
        return { kind: "timeout", id: timeoutCallbacks.length };
      },
      clearTimeout(handle: unknown) {
        clearedTimeouts.push(handle);
        activeDiagnostics?.log("manual-timer.clear-timeout", {
          handle,
          clearedCount: clearedTimeouts.length,
        });
      },
      setInterval(callback: () => void) {
        intervalCallbacks.push(callback);
        activeDiagnostics?.log("manual-timer.set-interval", {
          callbackCount: intervalCallbacks.length,
        });
        return { kind: "interval", id: intervalCallbacks.length };
      },
      clearInterval(handle: unknown) {
        clearedIntervals.push(handle);
        activeDiagnostics?.log("manual-timer.clear-interval", {
          handle,
          clearedCount: clearedIntervals.length,
        });
      },
    },
  };
}

function parseSentMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

async function withSocketDiagnostics(name: string, run: (diagnostics: FailureDiagnostics) => Promise<void>) {
  const diagnostics = createFailureDiagnostics(name);
  activeDiagnostics = diagnostics;
  try {
    await run(diagnostics);
  } catch (error) {
    diagnostics.flush(error);
    throw error;
  } finally {
    activeDiagnostics = null;
  }
}

describe("AgentSocket runtime dispatch", () => {
  test.serial("reports invalid socket envelopes without invoking onEvent", async () => {
    await withSocketDiagnostics(
      "reports invalid socket envelopes without invoking onEvent",
      async (diagnostics) => {
        FakeWebSocket.instances = [];
        const invalid: InvalidServerEvent[] = [];
        const received: string[] = [];

        const socket = new AgentSocket({
          url: "ws://example.test/socket",
          client: "test-client",
          WebSocketImpl: FakeWebSocket as any,
          pingIntervalMs: 0,
          onEvent: (evt) => {
            received.push(evt.type);
            diagnostics.log("onEvent", { type: evt.type });
          },
          onInvalidEvent: (evt) => {
            invalid.push(evt);
            diagnostics.log("onInvalidEvent", evt);
          },
        });

        socket.connect();
        diagnostics.log("after connect", {
          socketCount: FakeWebSocket.instances.length,
        });
        await flushMicrotasks();

        const ws = FakeWebSocket.instances[0];
        diagnostics.log("after initial microtasks", {
          socketCount: FakeWebSocket.instances.length,
          socketSent: ws?.sent ?? null,
        });
        expect(ws).toBeDefined();
        await ws!.emitMessage("{not-json");

        diagnostics.log("after invalid payload", { received, invalid });
        expect(received).toHaveLength(0);
        expect(invalid).toHaveLength(1);
        expect(invalid[0]?.reason).toBe("invalid_json");
      }
    );
  });

  test.serial("does not swallow onEvent exceptions as invalid_envelope", async () => {
    await withSocketDiagnostics(
      "does not swallow onEvent exceptions as invalid_envelope",
      async (diagnostics) => {
        FakeWebSocket.instances = [];
        const invalid: InvalidServerEvent[] = [];
        const consumerError = new Error("consumer handler exploded");

        const socket = new AgentSocket({
          url: "ws://example.test/socket",
          client: "test-client",
          WebSocketImpl: FakeWebSocket as any,
          pingIntervalMs: 0,
          onEvent: () => {
            diagnostics.log("onEvent.throw", { message: consumerError.message });
            throw consumerError;
          },
          onInvalidEvent: (evt) => {
            invalid.push(evt);
            diagnostics.log("onInvalidEvent", evt);
          },
        });

        socket.connect();
        await flushMicrotasks();

        const ws = FakeWebSocket.instances[0];
        diagnostics.log("after initial microtasks", {
          socketCount: FakeWebSocket.instances.length,
          socketSent: ws?.sent ?? null,
        });
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

        diagnostics.log("after consumer throw", { invalid });
        expect(invalid).toHaveLength(0);
      }
    );
  });

  test.serial("reconnects with resumeSessionId and flushes queued messages only after server_hello", async () => {
    await withSocketDiagnostics(
      "reconnects with resumeSessionId and flushes queued messages only after server_hello",
      async (diagnostics) => {
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
          onEvent: (evt) => diagnostics.log("onEvent", { type: evt.type }),
          onClose: (reason) => {
            onClose.push(reason);
            diagnostics.log("onClose", { reason });
          },
        });

        socket.connect();
        await flushMicrotasks();

        const ws1 = FakeWebSocket.instances[0];
        diagnostics.log("after first connect", {
          socketCount: FakeWebSocket.instances.length,
          ws1Sent: ws1?.sent ?? null,
        });
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

        diagnostics.log("after first hello", {
          ws1Sent: ws1?.sent ?? null,
          timeoutCount: timers.timeoutCallbacks.length,
        });
        ws1!.close();
        diagnostics.log("after first close", {
          timeoutCount: timers.timeoutCallbacks.length,
          onClose,
        });
        expect(timers.timeoutCallbacks).toHaveLength(1);
        expect(onClose).toHaveLength(0);

        expect(
          socket.send({ type: "user_message", sessionId: "sess-1", text: "retry me" }),
        ).toBe(true);
        diagnostics.log("after queued send", {
          ws1Sent: ws1?.sent ?? null,
          timeoutCount: timers.timeoutCallbacks.length,
        });

        timers.timeoutCallbacks[0]!();
        diagnostics.log("after reconnect timer fired", {
          socketCount: FakeWebSocket.instances.length,
        });
        await flushMicrotasks();

        const ws2 = FakeWebSocket.instances[1];
        diagnostics.log("after second connect", {
          socketCount: FakeWebSocket.instances.length,
          ws2Sent: ws2?.sent ?? null,
        });
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

        diagnostics.log("after second hello", { ws2Sent: ws2?.sent ?? null });
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
      }
    );
  });

  test.serial("sends keepalive pings only after a session is established", async () => {
    await withSocketDiagnostics(
      "sends keepalive pings only after a session is established",
      async (diagnostics) => {
        FakeWebSocket.instances = [];
        const timers = createManualTimers();

        const socket = new AgentSocket({
          url: "ws://example.test/socket",
          client: "test-client",
          WebSocketImpl: FakeWebSocket as any,
          pingIntervalMs: 1000,
          timers: timers.scheduler,
          onEvent: (evt) => diagnostics.log("onEvent", { type: evt.type }),
        });

        socket.connect();
        await flushMicrotasks();

        const ws = FakeWebSocket.instances[0];
        diagnostics.log("after connect", {
          socketCount: FakeWebSocket.instances.length,
          intervalCount: timers.intervalCallbacks.length,
          wsSent: ws?.sent ?? null,
        });
        expect(ws).toBeDefined();
        expect(timers.intervalCallbacks).toHaveLength(1);

        timers.intervalCallbacks[0]!();
        diagnostics.log("after first ping tick", { wsSent: ws?.sent ?? null });
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
        diagnostics.log("after second ping tick", { wsSent: ws?.sent ?? null });
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
        diagnostics.log("after close", {
          clearedIntervals: timers.clearedIntervals,
        });
        expect(timers.clearedIntervals).not.toHaveLength(0);
      }
    );
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
      activeDiagnostics?.log("delayed-socket.construct", {
        instanceCount: DelayedOpenWebSocket.instances.length,
      });
    }

    triggerOpen() {
      this.readyState = DelayedOpenWebSocket.OPEN;
      activeDiagnostics?.log("delayed-socket.open", {
        readyState: this.readyState,
      });
      this.onopen?.();
    }

    send(data: string) {
      this.sent.push(String(data));
      activeDiagnostics?.log("delayed-socket.send", {
        readyState: this.readyState,
        data,
      });
    }

    async emitMessage(data: unknown) {
      if (!this.onmessage) throw new Error("no message handler");
      activeDiagnostics?.log("delayed-socket.emit-message", { data });
      await this.onmessage({ data });
    }

    close() {
      this.readyState = DelayedOpenWebSocket.CLOSED;
      activeDiagnostics?.log("delayed-socket.close", {
        readyState: this.readyState,
      });
      this.onclose?.();
    }
  }

  test.serial("queues user messages until server_hello flushes them", async () => {
    await withSocketDiagnostics(
      "queues user messages until server_hello flushes them",
      async (diagnostics) => {
        DelayedOpenWebSocket.instances = [];
        const socket = new AgentSocket({
          url: "ws://example.test/socket",
          client: "test-client",
          WebSocketImpl: DelayedOpenWebSocket as any,
          pingIntervalMs: 0,
          autoReconnect: true,
          onEvent: (evt) => diagnostics.log("onEvent", { type: evt.type }),
        });

        socket.connect();
        const ws = DelayedOpenWebSocket.instances[0];
        diagnostics.log("after connect", {
          socketCount: DelayedOpenWebSocket.instances.length,
        });
        expect(ws).toBeDefined();

        const sendAccepted = socket.send({ type: "user_message", text: "queued" } as any);
        diagnostics.log("after queued send", {
          sendAccepted,
          sent: ws?.sent ?? null,
        });
        expect(sendAccepted).toBe(true);
        expect(ws?.sent).toHaveLength(0);

        ws?.triggerOpen();
        await flushMicrotasks();

        diagnostics.log("after triggerOpen", {
          sent: ws?.sent ?? null,
        });
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

        diagnostics.log("after server_hello", {
          sent: ws?.sent ?? null,
          userMessages,
        });
        expect(userMessages?.length).toBe(1);
      }
    );
  });
});
