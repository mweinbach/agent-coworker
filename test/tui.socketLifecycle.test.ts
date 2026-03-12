import { beforeEach, describe, expect, test } from "bun:test";

import { createSocketLifecycle } from "../apps/TUI/context/socketLifecycle";

const mockSockets: Array<{ options: any; sent: unknown[]; closed?: boolean; connected?: boolean }> = [];

class MockAgentSocket {
  public sent: unknown[] = [];
  public closed = false;
  public connected = false;
  constructor(public readonly options: any) {
    mockSockets.push(this);
  }

  connect() {
    this.connected = true;
  }

  send(message: unknown) {
    this.sent.push(message);
    return true;
  }

  close() {
    this.closed = true;
  }

  emitEvent(evt: any) {
    this.options.onEvent(evt);
  }

  emitOpen() {
    this.options.onOpen();
  }

  emitClose() {
    this.options.onClose();
  }
}

beforeEach(() => {
  mockSockets.length = 0;
});

describe("socketLifecycle", () => {
  test("connect picks the latest session id and proxies sends", () => {
    const lifecycle = createSocketLifecycle({
      serverUrl: "ws://mock",
      onEvent: () => {},
      onOpen: () => {},
      onClose: () => {},
      createSocket: (options) => new MockAgentSocket(options),
    });

    lifecycle.setLatestSessionId("saved-id");
    lifecycle.connect();

    expect(mockSockets).toHaveLength(1);
    expect(mockSockets[0].options.resumeSessionId).toBe("saved-id");
    expect(lifecycle.hasSocket()).toBe(true);
    expect(lifecycle.send({ type: "ping" })).toBe(true);
    expect(mockSockets[0].sent[0]).toEqual({ type: "ping" });
  });

  test("restart updates latest session id and reconnects", () => {
    const lifecycle = createSocketLifecycle({
      serverUrl: "ws://mock",
      onEvent: () => {},
      onOpen: () => {},
      onClose: () => {},
      createSocket: (options) => new MockAgentSocket(options),
    });

    lifecycle.connect();
    expect(mockSockets).toHaveLength(1);

    lifecycle.restart("  resumed-session  ");
    expect(mockSockets).toHaveLength(2);
    expect(mockSockets[0].closed).toBe(true);
    expect(lifecycle.getLatestSessionId()).toBe("resumed-session");
    expect(mockSockets[1].options.resumeSessionId).toBe("resumed-session");
  });

  test("disconnect can clear the latest session id", () => {
    const lifecycle = createSocketLifecycle({
      serverUrl: "ws://mock",
      onEvent: () => {},
      onOpen: () => {},
      onClose: () => {},
      createSocket: (options) => new MockAgentSocket(options),
    });

    lifecycle.setLatestSessionId("keep-me");
    lifecycle.disconnect({ clearLatestSessionId: true });

    expect(lifecycle.getLatestSessionId()).toBeNull();
  });

  test("stale generation events are ignored after disconnect", () => {
    const events: any[] = [];
    const lifecycle = createSocketLifecycle({
      serverUrl: "ws://mock",
      onEvent: (evt) => events.push(evt),
      onOpen: () => {},
      onClose: () => {},
      createSocket: (options) => new MockAgentSocket(options),
    });

    lifecycle.connect();
    expect(mockSockets).toHaveLength(1);
    mockSockets[0].emitEvent({ type: "session_busy", sessionId: "s1" });
    expect(events).toHaveLength(1);

    lifecycle.disconnect();
    mockSockets[0].emitEvent({ type: "session_busy", sessionId: "s1" });
    expect(events).toHaveLength(1);
  });
});
