import { describe, expect, test } from "bun:test";

let rlRef: FakeReadline | null = null;
let capturedTurnStart: Record<string, unknown> | null = null;
let startupResponseCount = 0;

class FakeReadline {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();

  setPrompt(_prompt: string) {
    // no-op
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

  readyState = FakeWebSocket.CONNECTING;
  onopen: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onmessage: null | ((ev: { data: any }) => void) = null;
  onclose: null | (() => void) = null;

  constructor(_url: string, _protocols?: string | string[]) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    const parsed = JSON.parse(data);
    if (parsed?.method === "initialize" && parsed?.id != null) {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: parsed.id, result: { serverInfo: { name: "test" } } }) });
      });
      return;
    }

    if ((parsed?.method === "thread/start" || parsed?.method === "thread/resume") && parsed?.id != null) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
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
          }),
        });
      });
      return;
    }

    if (
      (parsed?.method === "cowork/session/state/read"
        || parsed?.method === "cowork/provider/catalog/read"
        || parsed?.method === "cowork/provider/authMethods/read")
      && parsed?.id != null
    ) {
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
                all: [{ id: "openai" }, { id: "google" }],
                default: { openai: "gpt-5.4", google: "gemini-3.1-pro-preview" },
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
      queueMicrotask(() => {
        startupResponseCount += 1;
        this.onmessage?.({ data: JSON.stringify({ id: parsed.id, result }) });
      });
      return;
    }

    if (parsed?.method === "turn/start" && parsed?.id != null) {
      capturedTurnStart = parsed;
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: parsed.id,
            result: {
              turn: {
                id: "turn-1",
                threadId: "thread-test",
                status: "running",
                items: [],
              },
            },
          }),
        });
      });
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => {
      this.onclose?.();
    });
  }
}

async function waitForHarnessReady(timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (rlRef && startupResponseCount >= 3) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for REPL harness");
}

describe("CLI REPL thread envelope handling", () => {
  test("uses thread.id from the JSON-RPC thread envelope for the first turn", async () => {
    rlRef = null;
    capturedTurnStart = null;
    startupResponseCount = 0;
    const originalLog = console.log;
    console.log = (() => {}) as any;

    try {
      const { runCliRepl } = await import("../src/cli/repl");
      const replPromise = runCliRepl({
        __internal: {
          startAgentServer: async () => ({
            server: { stop() {} },
            url: "ws://mock",
            config: {} as any,
            system: "",
          }),
          WebSocket: FakeWebSocket as any,
          createReadlineInterface: () => {
            rlRef = new FakeReadline();
            return rlRef as any;
          },
        },
      });
      await waitForHarnessReady();
      await rlRef!.emitLine("hello");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(capturedTurnStart).toBeTruthy();
      expect(capturedTurnStart?.params).toEqual({
        threadId: "thread-test",
        input: [{ type: "text", text: "hello" }],
        clientMessageId: expect.any(String),
      });

      rlRef!.close();
      await replPromise;
    } finally {
      console.log = originalLog;
    }
  });
});
