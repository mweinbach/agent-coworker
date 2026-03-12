import { describe, expect, test } from "bun:test";

import type { ClientMessage, ServerEvent } from "../src/server/protocol";
import { createFailureDiagnostics } from "./shared/failureDiagnostics";

type FailureDiagnostics = ReturnType<typeof createFailureDiagnostics>;

let rlRef: FakeReadline | null = null;
let activeDiagnostics: FailureDiagnostics | null = null;

class FakeReadline {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();
  private closed = false;
  lastPrompt: string | null = null;

  setPrompt(_p: string) {
    this.lastPrompt = _p;
    activeDiagnostics?.log("fake-readline.set-prompt", { prompt: _p });
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
    activeDiagnostics?.log("fake-readline.close");
    const list = this.handlers.get("close") ?? [];
    for (const cb of list) cb();
  }

  async emitLine(line: string) {
    activeDiagnostics?.log("fake-readline.emit-line", { line });
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
    activeDiagnostics?.log("fake-socket.construct", {
      instanceCount: FakeWebSocket.instances.length,
    });
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      activeDiagnostics?.log("fake-socket.open", { readyState: this.readyState });
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(String(data));
    activeDiagnostics?.log("fake-socket.send", {
      readyState: this.readyState,
      data,
    });
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
      activeDiagnostics?.log("fake-socket.schedule-server-hello");
      queueMicrotask(() => {
        activeDiagnostics?.log("fake-socket.emit-server-hello", hello);
        this.onmessage?.({ data: JSON.stringify(hello) });
      });
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    activeDiagnostics?.log("fake-socket.close", { readyState: this.readyState });
    queueMicrotask(() => {
      activeDiagnostics?.log("fake-socket.emit-close");
      this.onclose?.();
    });
  }
}

function getHarnessSnapshot() {
  return {
    hasReadline: !!rlRef,
    socketCount: FakeWebSocket.instances.length,
    readyStates: FakeWebSocket.instances.map((ws) => ws.readyState),
    sentMessages: FakeWebSocket.instances.map((ws) => ws.sent),
  };
}

async function waitForCliReady(timeoutMs = 1_000) {
  const startedAt = Date.now();
  activeDiagnostics?.log("wait-for-cli-ready.start", getHarnessSnapshot());
  while (Date.now() - startedAt < timeoutMs) {
    if (rlRef && FakeWebSocket.instances[0]) {
      activeDiagnostics?.log("wait-for-cli-ready.ready", getHarnessSnapshot());
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const snapshot = getHarnessSnapshot();
  activeDiagnostics?.log("wait-for-cli-ready.timeout", snapshot);
  throw new Error(`Timed out waiting for CLI test harness to connect: ${JSON.stringify(snapshot)}`);
}

async function withReplDiagnostics(name: string, run: (diagnostics: FailureDiagnostics) => Promise<void>) {
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

describe("CLI REPL websocket send failures", () => {
  test("surfaces an error and does not silently drop a user_message when ws is not OPEN", async () => {
    await withReplDiagnostics(
      "surfaces an error and does not silently drop a user_message when ws is not OPEN",
      async (diagnostics) => {
        rlRef = null;
        FakeWebSocket.instances = [];
        const realLog = console.log;
        const realErr = console.error;

        try {
          const logs: string[] = [];
          console.log = (...args: any[]) => {
            const line = args.join(" ");
            logs.push(line);
            diagnostics.log("console.log", { line });
          };
          console.error = (...args: any[]) => {
            const line = args.join(" ");
            logs.push(line);
            diagnostics.log("console.error", { line });
          };

          const { runCliRepl } = await import("../src/cli/repl");

          const replPromise = runCliRepl({
            __internal: {
              startAgentServer: startAgentServerStub as any,
              WebSocket: FakeWebSocket as any,
              createReadlineInterface: () => {
                rlRef = new FakeReadline();
                diagnostics.log("create-readline", getHarnessSnapshot());
                return rlRef as any;
              },
            },
          });

          diagnostics.log("after runCliRepl", getHarnessSnapshot());
          await waitForCliReady();

          const ws = FakeWebSocket.instances[0];
          diagnostics.log("after waitForCliReady", {
            harness: getHarnessSnapshot(),
            logs,
          });
          expect(ws).toBeDefined();
          expect(rlRef).toBeDefined();

          // Simulate a dropped socket where readyState is no longer OPEN, but no close
          // event has fired yet (the edge case that previously silently dropped input).
          ws.readyState = FakeWebSocket.CLOSED;
          diagnostics.log("forced-socket-closed", {
            readyState: ws.readyState,
            sent: ws.sent,
          });

          await rlRef!.emitLine("hello");

          diagnostics.log("after hello", {
            logs,
            harness: getHarnessSnapshot(),
            prompt: rlRef?.lastPrompt ?? null,
          });
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
          diagnostics.log("after sent-types", { sentTypes });
          expect(sentTypes).not.toContain("user_message");

          rlRef!.close();
          await replPromise;
        } finally {
          console.log = realLog;
          console.error = realErr;
        }
      },
    );
  });
});
