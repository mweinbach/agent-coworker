import { describe, expect, test } from "bun:test";

import type { ClientMessage, ServerEvent } from "../src/server/protocol";

let rlRef: FakeReadline | null = null;

class FakeReadline {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();
  private closed = false;

  lastPrompt: string | null = null;

  setPrompt(p: string) {
    this.lastPrompt = p;
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

describe("CLI REPL restart failure recovery", () => {
  test("does not get stuck after a failed /restart (serverStopping reset; disconnect cleanup not skipped)", async () => {
    rlRef = null;
    FakeWebSocket.instances = [];
    const realLog = console.log;
    const realErr = console.error;

    try {
      const logs: string[] = [];
      console.log = (...args: any[]) => logs.push(args.join(" "));
      console.error = (...args: any[]) => logs.push(args.join(" "));

      let startCalls = 0;
      const startAgentServerStub = async () => {
        startCalls++;
        if (startCalls >= 2) throw new Error("boom: start failed");

        return {
          server: {
            stop() {
              // Mimic server shutdown closing the active websocket.
              for (const ws of FakeWebSocket.instances) ws.close();
            },
          },
          url: "ws://mock",
          config: {} as any,
          system: "",
        };
      };

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

      expect(rlRef).toBeDefined();
      expect(FakeWebSocket.instances[0]).toBeDefined();

      await rlRef!.emitLine("/restart");
      expect(logs.join("\n")).toContain("restarting server...");
      expect(logs.join("\n")).toContain("Error:");

      const before = logs.length;
      await rlRef!.emitLine("hello");

      // The key regression: input must not be silently dropped after a failed restart.
      expect(logs.length).toBeGreaterThan(before);
      expect(logs.join("\n")).toMatch(/not connected:|disconnected:/);
      expect(rlRef!.lastPrompt).toBe("you> ");

      rlRef!.close();
      await replPromise;
    } finally {
      console.log = realLog;
      console.error = realErr;
    }
  });
});

