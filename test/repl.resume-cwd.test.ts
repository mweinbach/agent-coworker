import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getStoredSessionForCwd, setStoredSessionForCwd } from "../src/cli/repl/stateStore";

type MetadataRequest = {
  method: string;
  cwd: string;
};

let rlRef: FakeReadline | null = null;
let resumedThreadCwd = "";
let metadataRequests: MetadataRequest[] = [];
let setApiKeyRequestCwd: string | null = null;

class FakeReadline {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();
  private closed = false;

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

    if (parsed?.method === "thread/resume" && parsed?.id != null) {
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
                cwd: resumedThreadCwd,
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
      metadataRequests.push({
        method: parsed.method,
        cwd: String(parsed.params?.cwd ?? ""),
      });

      const result = parsed.method === "cowork/session/state/read"
        ? {
            events: [
              {
                type: "config_updated",
                sessionId: "thread-remote",
                config: {
                  provider: "openai",
                  model: "gpt-5.4",
                  workingDirectory: resumedThreadCwd,
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

    if (parsed?.method === "cowork/provider/auth/setApiKey" && parsed?.id != null) {
      setApiKeyRequestCwd = String(parsed.params?.cwd ?? "");
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: parsed.id,
            result: {
              event: {
                type: "provider_auth_result",
                sessionId: "thread-remote",
                provider: "openai",
                methodId: "api_key",
                ok: true,
                mode: "api_key",
                message: "API key saved.",
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for REPL state");
}

describe("CLI REPL resume cwd handling", () => {
  test("uses the resumed thread cwd for metadata, persistence, and later workspace-scoped commands", async () => {
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;
    const originalLog = console.log;
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-home-"));
    const initialDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-initial-"));
    resumedThreadCwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-resumed-"));
    metadataRequests = [];
    setApiKeyRequestCwd = null;
    console.log = (() => {}) as any;

    try {
      process.env.HOME = homeDir;
      await setStoredSessionForCwd(initialDir, "thread-remote");

      const { runCliRepl } = await import("../src/cli/repl");
      const replPromise = runCliRepl({
        dir: initialDir,
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

      await waitFor(() => metadataRequests.length === 3);

      expect(metadataRequests).toEqual([
        { method: "cowork/session/state/read", cwd: resumedThreadCwd },
        { method: "cowork/provider/catalog/read", cwd: resumedThreadCwd },
        { method: "cowork/provider/authMethods/read", cwd: resumedThreadCwd },
      ]);
      expect(await getStoredSessionForCwd(resumedThreadCwd)).toBe("thread-remote");

      await rlRef!.emitLine("/connect openai sk-test");
      await waitFor(() => setApiKeyRequestCwd !== null);

      expect(setApiKeyRequestCwd).toBe(resumedThreadCwd);

      rlRef?.close();
      await replPromise;
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
      rlRef = null;
      metadataRequests = [];
      setApiKeyRequestCwd = null;
      resumedThreadCwd = "";
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
