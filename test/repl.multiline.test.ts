import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function makeTmpDir(prefix = "repl-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

class FakeReadline {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();
  private closed = false;
  lastPrompt: string | null = null;

  setPrompt(_p: string) {
    this.lastPrompt = _p;
  }

  prompt() {}

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
    for (const cb of list) {
      const res = cb(line);
      if (res instanceof Promise) {
        await res;
      }
    }
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

  constructor(_url: string, _protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(String(data));
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      parsed = null;
    }

    // Respond to JSON-RPC initialize request
    if (parsed?.method === "initialize" && parsed?.id != null) {
      queueMicrotask(() => {
        const response = { id: parsed.id, result: { serverInfo: { name: "test" } } };
        this.onmessage?.({ data: JSON.stringify(response) });
      });
    }
    // Respond to thread/start request
    if (parsed?.method === "thread/start" && parsed?.id != null) {
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
        this.onmessage?.({ data: JSON.stringify(response) });
      });
    }
    // Respond to thread/resume request
    if (parsed?.method === "thread/resume" && parsed?.id != null) {
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
        this.onmessage?.({ data: JSON.stringify(response) });
      });
    }
    // Respond to turn/start
    if (parsed?.method === "turn/start" && parsed?.id != null) {
      queueMicrotask(() => {
        const response = { id: parsed.id, result: { turnId: "turn-test" } };
        this.onmessage?.({ data: JSON.stringify(response) });
      });
    }
    if (
      (parsed?.method === "cowork/session/state/read" ||
        parsed?.method === "cowork/provider/catalog/read" ||
        parsed?.method === "cowork/provider/authMethods/read") &&
      parsed?.id != null
    ) {
      queueMicrotask(() => {
        const result =
          parsed.method === "cowork/session/state/read"
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
    queueMicrotask(() => {
      this.onclose?.();
    });
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

describe("CLI REPL Multi-line paste input", () => {
  test("aggregates multiple fast lines into a single multi-line message if they do not start with a command", async () => {
    const originalCwd = process.cwd();
    const tmp = await makeTmpDir();
    FakeWebSocket.instances = [];
    let rlRef: FakeReadline | null = null;
    const { runCliRepl } = await import("../src/cli/repl");

    const logs: string[] = [];
    const realLog = console.log;
    const realErr = console.error;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };
    console.error = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      const replPromise = runCliRepl({
        dir: tmp,
        __internal: {
          startAgentServer: startAgentServerStub as any,
          WebSocket: FakeWebSocket as any,
          createReadlineInterface: () => {
            rlRef = new FakeReadline();
            return rlRef as any;
          },
        },
      });

      // Wait for websocket handshake to establish
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(rlRef).not.toBeNull();
      expect(FakeWebSocket.instances.length).toBe(1);
      const ws = FakeWebSocket.instances[0];

      // Emit 3 lines very quickly without awaiting, mimicking a paste of a multi-line message
      rlRef!.emitLine("Line 1");
      rlRef!.emitLine("Line 2");
      rlRef!.emitLine("Line 3");

      // Wait for the timeout to fire and process the input
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      realLog("Logs during execution:", logs);
      realLog("WS Sent Messages:", ws.sent);

      // Inspect sent requests
      const turnStarts = ws.sent.map((m) => JSON.parse(m)).filter((p) => p.method === "turn/start");

      expect(turnStarts.length).toBe(1);
      expect(turnStarts[0].params.input[0].text).toBe("Line 1\nLine 2\nLine 3");

      rlRef!.close();
      await replPromise;
    } finally {
      console.log = realLog;
      console.error = realErr;
      process.chdir(originalCwd);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("processes multiple fast lines individually if the first line starts with a command", async () => {
    const originalCwd = process.cwd();
    const tmp = await makeTmpDir();
    FakeWebSocket.instances = [];
    let rlRef: FakeReadline | null = null;
    const { runCliRepl } = await import("../src/cli/repl");

    const logs: string[] = [];
    const realLog = console.log;
    const realErr = console.error;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };
    console.error = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      const replPromise = runCliRepl({
        dir: tmp,
        __internal: {
          startAgentServer: startAgentServerStub as any,
          WebSocket: FakeWebSocket as any,
          createReadlineInterface: () => {
            rlRef = new FakeReadline();
            return rlRef as any;
          },
        },
      });

      // Wait for websocket handshake to establish
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(rlRef).not.toBeNull();
      expect(FakeWebSocket.instances.length).toBe(1);
      const ws = FakeWebSocket.instances[0];

      // Emit a command followed by a message quickly without awaiting
      rlRef!.emitLine("/new");
      rlRef!.emitLine("Hello after new");

      // Wait for the timeout to fire and process the input
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const turnStarts = ws.sent.map((m) => JSON.parse(m)).filter((p) => p.method === "turn/start");

      // /new clears thread, doesn't send turn/start.
      // The second line is a message, which starts a turn.
      expect(turnStarts.length).toBe(1);
      expect(turnStarts[0].params.input[0].text).toBe("Hello after new");

      rlRef!.close();
      await replPromise;
    } finally {
      console.log = realLog;
      console.error = realErr;
      process.chdir(originalCwd);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
