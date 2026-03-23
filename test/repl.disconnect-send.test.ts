import { describe, expect, test } from "bun:test";

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
    url: "ws://mock",
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

  constructor(_url: string, _protocols?: string | string[]) {
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
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      parsed = null;
    }
    // Respond to JSON-RPC initialize request
    if (parsed?.method === "initialize" && parsed?.id != null) {
      activeDiagnostics?.log("fake-socket.schedule-initialize-response");
      queueMicrotask(() => {
        const response = { id: parsed.id, result: { serverInfo: { name: "test" } } };
        activeDiagnostics?.log("fake-socket.emit-initialize-response", response);
        this.onmessage?.({ data: JSON.stringify(response) });
      });
    }
    // Respond to thread/start request
    if (parsed?.method === "thread/start" && parsed?.id != null) {
      activeDiagnostics?.log("fake-socket.schedule-thread-start-response");
      queueMicrotask(() => {
        const response = {
          id: parsed.id,
          result: {
            thread: {
              id: "thread-test",
              title: "",
              preview: "",
              modelProvider: "openai",
              model: "gpt-5.4",
              cwd: process.cwd(),
              createdAt: "2026-03-23T00:00:00.000Z",
              updatedAt: "2026-03-23T00:00:00.000Z",
              messageCount: 0,
              lastEventSeq: 0,
              status: { type: "loaded" },
            },
          },
        };
        activeDiagnostics?.log("fake-socket.emit-thread-start-response", response);
        this.onmessage?.({ data: JSON.stringify(response) });
      });
    }
    // Respond to thread/resume request
    if (parsed?.method === "thread/resume" && parsed?.id != null) {
      activeDiagnostics?.log("fake-socket.schedule-thread-resume-response");
      queueMicrotask(() => {
        const response = {
          id: parsed.id,
          result: {
            thread: {
              id: "thread-test",
              title: "",
              preview: "",
              modelProvider: "openai",
              model: "gpt-5.4",
              cwd: process.cwd(),
              createdAt: "2026-03-23T00:00:00.000Z",
              updatedAt: "2026-03-23T00:00:00.000Z",
              messageCount: 0,
              lastEventSeq: 0,
              status: { type: "loaded" },
            },
          },
        };
        activeDiagnostics?.log("fake-socket.emit-thread-resume-response", response);
        this.onmessage?.({ data: JSON.stringify(response) });
      });
    }
    if (
      (parsed?.method === "cowork/session/state/read"
        || parsed?.method === "cowork/provider/catalog/read"
        || parsed?.method === "cowork/provider/authMethods/read")
      && parsed?.id != null
    ) {
      queueMicrotask(() => {
        const result = parsed.method === "cowork/session/state/read"
          ? {
              events: [
                {
                  type: "config_updated",
                  sessionId: "thread-test",
                  config: {
                    provider: "openai",
                    model: "gpt-5.4",
                    workingDirectory: process.cwd(),
                  },
                },
                {
                  type: "session_settings",
                  sessionId: "thread-test",
                  enableMcp: true,
                  enableMemory: true,
                  memoryRequireApproval: false,
                },
                {
                  type: "session_config",
                  sessionId: "thread-test",
                  config: {
                    enableMemory: true,
                  },
                },
              ],
            }
          : parsed.method === "cowork/provider/catalog/read"
            ? {
                event: {
                  type: "provider_catalog",
                  sessionId: "thread-test",
                  all: [{ id: "openai" }],
                  default: { openai: "gpt-5.4" },
                  connected: ["openai"],
                },
              }
            : {
                event: {
                  type: "provider_auth_methods",
                  sessionId: "thread-test",
                  methods: {
                    openai: [{ id: "api_key", type: "api", label: "API key" }],
                  },
                },
              };
        this.onmessage?.({ data: JSON.stringify({ id: parsed.id, result }) });
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

async function waitForCliReady(timeoutMs = 2_000) {
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

          // Wait for the handshake + thread start to complete
          await new Promise<void>((resolve) => setTimeout(resolve, 200));

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
          // The error message should indicate disconnection or inability to send.
          expect(logs.join("\n")).toMatch(/disconnected:|Error:|not ready/i);
          expect(rlRef!.lastPrompt).toBe("you> ");

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
