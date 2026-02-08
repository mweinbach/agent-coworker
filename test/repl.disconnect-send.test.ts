import { describe, expect, test } from "bun:test";

import type { ClientMessage, ServerEvent } from "../src/server/protocol";

let rlRef: FakeReadline | null = null;

class FakeReadline {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();
  private closed = false;
  lastPrompt: string | null = null;

  setPrompt(_p: string) {
    this.lastPrompt = _p;
  }

  prompt() {
    // no-op
  }

  on(event: string, cb: (...args: any[]) => any) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const list = this.handlers.get("close") ?? [];
    for (const cb of list) cb();
  }

  async emitLine(line: string) {
    const list = this.handlers.get("line") ?? [];
    for (const cb of list) await cb(line);
  }
}

const startAgentServerStub = async () => {
  return {
    server: { stop() {} },
    // url string is opaque to the REPL; it just passes it to WebSocket().
    url: "ws://mock",
    // unused by the REPL, but part of the real return type
    config: {} as any,
    system: "",
  };
};

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
  onmessage: null | ((ev: { data: any }) => void) = null;
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
    let parsed: ClientMessage | null = null;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      parsed = null;
    }
    if (parsed?.type === "client_hello") {
      const hello: ServerEvent = {
        type: "server_hello",
        sessionId: "sess-test",
        config: {
          provider: "openai",
          model: "gpt-test",
          workingDirectory: "/tmp",
          outputDirectory: "/tmp/output",
        },
      };
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(hello) }));
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.());
  }
}

describe("CLI REPL websocket send failures", () => {
  test("surfaces an error and does not silently drop a user_message when ws is not OPEN", async () => {
    rlRef = null;
    FakeWebSocket.instances = [];
    const realLog = console.log;
    const realErr = console.error;

    try {
      const logs: string[] = [];
      console.log = (...args: any[]) => logs.push(args.join(" "));
      console.error = (...args: any[]) => logs.push(args.join(" "));

      const { runCliRepl } = await import("../src/cli/repl");

      const replPromise = runCliRepl({
        __internal: {
          startAgentServer: startAgentServerStub as any,
          WebSocket: FakeWebSocket as any,
          createReadlineInterface: () => {
            rlRef = new FakeReadline();
            return rlRef as any;
          },
        },
      });

      // Allow handshake and readline wiring to complete.
      await new Promise((r) => setTimeout(r, 5));

      const ws = FakeWebSocket.instances[0];
      expect(ws).toBeDefined();
      expect(rlRef).toBeDefined();

      // Simulate a dropped socket where readyState is no longer OPEN, but no close
      // event has fired yet (the edge case that previously silently dropped input).
      ws.readyState = FakeWebSocket.CLOSED;

      await rlRef!.emitLine("hello");

      expect(logs.join("\n")).toContain("disconnected:");
      expect(logs.join("\n")).toContain("unable to send (not connected)");
      expect(logs.join("\n")).toContain("/restart");
      expect(rlRef!.lastPrompt).toBe("you> ");

      const sentTypes = ws.sent
        .map((raw) => {
          try {
            return JSON.parse(raw)?.type;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      expect(sentTypes).not.toContain("user_message");

      rlRef!.close();
      await replPromise;
    } finally {
      console.log = realLog;
      console.error = realErr;
    }
  });
});
