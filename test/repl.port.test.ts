import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCliRepl } from "../src/cli/repl";

class FakeReadline {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();
  private closed = false;

  setPrompt() {}
  prompt() {}

  on(event: string, cb: (...args: any[]) => any) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    if (event === "close" && this.closed) {
      cb();
    }
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const list = this.handlers.get("close") ?? [];
    for (const cb of list) cb();
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: null | (() => void) = null;
  onmessage: null | ((ev: { data: any }) => void) = null;
  onclose: null | (() => void) = null;

  constructor() {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    const parsed = JSON.parse(data);
    if (parsed?.method === "initialize" && parsed?.id != null) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({ id: parsed.id, result: { serverInfo: { name: "test" } } }),
        });
      });
      return;
    }
    if (parsed?.method === "thread/start" && parsed?.id != null) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: parsed.id,
            result: {
              thread: {
                id: "thread-remote",
                title: "",
                preview: "",
                modelProvider: "openai",
                model: "gpt-5.4",
                cwd: "/tmp",
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
      (parsed?.method === "cowork/session/state/read" ||
        parsed?.method === "cowork/provider/catalog/read" ||
        parsed?.method === "cowork/provider/authMethods/read") &&
      parsed?.id != null
    ) {
      const result =
        parsed.method === "cowork/session/state/read"
          ? {
              events: [
                {
                  type: "config_updated",
                  sessionId: "thread-remote",
                  config: {
                    provider: "openai",
                    model: "gpt-5.4",
                    workingDirectory: "/tmp",
                  },
                },
                {
                  type: "session_config",
                  sessionId: "thread-remote",
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
                  sessionId: "thread-remote",
                  all: [{ id: "openai" }],
                  default: { openai: "gpt-5.4" },
                  connected: ["openai"],
                },
              }
            : {
                event: {
                  type: "provider_auth_methods",
                  sessionId: "thread-remote",
                  methods: {
                    openai: [{ id: "api_key", type: "api", label: "API key" }],
                  },
                },
              };
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: parsed.id, result }) });
      });
      return;
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => {
      this.onclose?.();
    });
  }
}

describe("CLI REPL port option handling", () => {
  test("passes custom port to startAgentServer", async () => {
    let passedPort: number | undefined;
    let rlRef: FakeReadline | null = null;

    const startAgentServerMock = mock(async (opts: any) => {
      passedPort = opts.port;
      return {
        server: { stop() {} },
        url: "ws://mock",
        config: {} as any,
        system: "",
      };
    });

    const originalCwd = process.cwd();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repl-port-test-"));
    const originalLog = console.log;
    console.log = (() => {}) as any;

    try {
      const replPromise = runCliRepl({
        dir: tmpDir,
        port: 12345,
        __internal: {
          startAgentServer: startAgentServerMock,
          WebSocket: FakeWebSocket as any,
          createReadlineInterface: () => {
            rlRef = new FakeReadline();
            return rlRef as any;
          },
        },
      });

      // Wait for websocket handshake to establish
      await new Promise((resolve) => setTimeout(resolve, 500));

      rlRef?.close();
      await replPromise;

      expect(startAgentServerMock).toHaveBeenCalled();
      expect(passedPort).toBe(12345);
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
