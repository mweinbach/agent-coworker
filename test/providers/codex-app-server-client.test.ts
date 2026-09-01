import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scratchRoots } from "../../src/platform/sandbox";
import {
  __internal,
  type CodexAppServerClient,
  type CodexAppServerCloseInfo,
  type CodexAppServerJsonRpcRawMessage,
  closePooledCodexAppServerClients,
  getPooledCodexAppServerClient,
  startCodexAppServerClient,
  UNHANDLED_CODEX_APP_SERVER_REQUEST,
} from "../../src/providers/codexAppServerClient";

const originalHome = process.env.HOME;
const originalCommand = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
const originalArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;
const originalCodexHome = process.env.CODEX_HOME;

async function makeTmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-client-test-"));
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await fs.stat(filePath);
}

describe("codex app-server client", () => {
  afterEach(async () => {
    await closePooledCodexAppServerClients();
    __internal.setClientFactoryForTests(undefined);
    __internal.setSandboxSetupStateSyncForTests(undefined);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalCommand === undefined) {
      delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
    } else {
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = originalCommand;
    }
    if (originalArgs === undefined) {
      delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
    } else {
      process.env.COWORK_CODEX_APP_SERVER_ARGS = originalArgs;
    }
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("evicts pooled clients as soon as the app-server process exits", async () => {
    const home = await makeTmpHome();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-client-pool-"));
    process.env.HOME = home;

    let starts = 0;
    const clients: CodexAppServerClient[] = [];
    const makeClient = (): CodexAppServerClient => {
      starts += 1;
      const closeListeners = new Set<
        (code: number | null, signal: NodeJS.Signals | null) => void
      >();
      let closed = false;
      let closeInfo: CodexAppServerCloseInfo | null = null;
      const closeWithInfo = (code: number | null, signal: NodeJS.Signals | null) => {
        closed = true;
        closeInfo = { code, signal, stderrBytes: 0, closedAt: "2026-06-03T18:18:05.000Z" };
        for (const listener of closeListeners) listener(code, signal);
      };
      const client: CodexAppServerClient = {
        command: { command: "mock-codex-app-server", args: [], source: "override" },
        isClosed: () => closed,
        getLastCloseInfo: () => closeInfo,
        request: async () => ({ userAgent: "mock" }),
        notify: () => {},
        interruptTurn: async () => {},
        onNotification: () => () => {},
        onServerRequest: () => () => {},
        onJsonRpcMessage: () => () => {},
        onClose: (listener) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
        close: async () => closeWithInfo(null, "SIGTERM"),
      };
      clients.push(client);
      return client;
    };
    __internal.setClientFactoryForTests(async () => makeClient());
    const logLines: string[] = [];
    const first = await getPooledCodexAppServerClient({
      cwd: dir,
      log: (line) => logLines.push(line),
    });
    await first.close();
    expect(first.isClosed()).toBe(true);
    expect(first.getLastCloseInfo?.()).toEqual(
      expect.objectContaining({ code: null, signal: "SIGTERM", stderrBytes: 0 }),
    );

    const second = await getPooledCodexAppServerClient({
      cwd: dir,
      log: (line) => logLines.push(line),
    });
    expect(second).not.toBe(first);
    expect(starts).toBe(2);
    expect(clients).toHaveLength(2);
    expect(logLines.some((line) => line.includes("pooled client closed"))).toBe(true);
  });

  test("bounds app-server initialization and replaces a timed-out pooled client", async () => {
    const home = await makeTmpHome();
    process.env.HOME = home;
    const initializationTimeouts: Array<number | undefined> = [];
    let starts = 0;
    let failedClientClosed = false;

    __internal.setClientFactoryForTests(async () => {
      starts += 1;
      const attempt = starts;
      return {
        ...makeStubClient(),
        request: async (method, _params, timeoutMs) => {
          if (method === "initialize") {
            initializationTimeouts.push(timeoutMs);
          }
          if (attempt === 1) {
            throw new Error(`codex app-server initialize timed out after ${timeoutMs}ms`);
          }
          return { userAgent: "recovered" };
        },
        close: async () => {
          if (attempt === 1) failedClientClosed = true;
        },
      } satisfies CodexAppServerClient;
    });

    await expect(getPooledCodexAppServerClient()).rejects.toThrow(
      "initialize timed out after 15000ms",
    );
    expect(failedClientClosed).toBe(true);

    const recovered = await getPooledCodexAppServerClient();
    expect(recovered.isClosed()).toBe(false);
    expect(starts).toBe(2);
    expect(initializationTimeouts).toEqual([15_000, 15_000]);
  });

  test("shares one replacement when concurrent callers discover a closed pooled client", async () => {
    const home = await makeTmpHome();
    process.env.HOME = home;
    let starts = 0;
    let firstClosed = false;
    const replacements: CodexAppServerClient[] = [];

    __internal.setClientFactoryForTests(async () => {
      starts += 1;
      const attempt = starts;
      const client = {
        ...makeStubClient(),
        isClosed: () => attempt === 1 && firstClosed,
      } satisfies CodexAppServerClient;
      if (attempt > 1) replacements.push(client);
      return client;
    });

    await getPooledCodexAppServerClient();
    firstClosed = true;
    const recovered = await Promise.all([
      getPooledCodexAppServerClient(),
      getPooledCodexAppServerClient(),
      getPooledCodexAppServerClient(),
    ]);

    expect(starts).toBe(2);
    expect(replacements).toHaveLength(1);
    expect(recovered.every((client) => client === replacements[0])).toBe(true);
  });

  test("starts app-server with Cowork-owned CODEX_HOME", async () => {
    const home = await makeTmpHome();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-client-script-"));
    const envFile = path.join(dir, "env.json");
    const script = path.join(dir, "mock-codex-app-server.js");
    await fs.writeFile(
      script,
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  CODEX_HOME: process.env.CODEX_HOME,
  PATH: process.env.PATH,
  COWORK_TEST_TOOL_ENV: process.env.COWORK_TEST_TOOL_ENV
}));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, ".codex-should-not-be-used");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;

    const client = await startCodexAppServerClient({
      env: {
        PATH: "/tmp/cowork-managed-bin",
        COWORK_TEST_TOOL_ENV: "preserved",
        CODEX_HOME: path.join(home, ".codex-should-not-be-used-by-opts"),
      },
    });
    await waitForFile(envFile);
    await client.close();

    const expectedCodexHome = path.join(home, ".cowork", "auth", "codex-cli");
    expect(__internal.resolveCodexHome()).toBe(expectedCodexHome);
    expect(JSON.parse(await fs.readFile(envFile, "utf8"))).toEqual({
      CODEX_HOME: expectedCodexHome,
      PATH: "/tmp/cowork-managed-bin",
      COWORK_TEST_TOOL_ENV: "preserved",
    });
    expect((await fs.stat(expectedCodexHome)).isDirectory()).toBe(true);
  });

  test("spawn env strips inherited CODEX_* variables case-insensitively", () => {
    const codexHome = path.join("C:", "users", "example", ".cowork", "auth", "codex-cli");
    const spawnEnv = __internal.buildCodexSpawnEnv(
      {
        PATH: "/usr/bin",
        // Windows env names are case-insensitive: a differently cased
        // CODEX_HOME from a shell profile must not shadow the pinned value.
        Codex_Home: "C:\\Users\\example\\.codex",
        codex_home: "/home/example/.codex",
        CODEX_SANDBOX: "seatbelt",
        CODEX_SANDBOX_NETWORK_DISABLED: "1",
        CODEX_COMPANION_SESSION_ID: "abc-123",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "external-tool",
        NOT_CODEX_PREFIXED: "kept",
        MY_CODEX_TOOL: "kept-too",
      },
      codexHome,
    );

    expect(spawnEnv).toEqual({
      PATH: "/usr/bin",
      NOT_CODEX_PREFIXED: "kept",
      MY_CODEX_TOOL: "kept-too",
      CODEX_HOME: codexHome,
    });
  });

  test.each([false, true])(
    "scopes interleaved raw requests with throwing observers=%s",
    async (throws) => {
      const dir = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-codex-rpc-scope-"));
      const script = path.join(dir, "mock.cjs");
      await fs.writeFile(
        script,
        `const readline = require("node:readline");
const pending = [];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  pending.push(request);
  if (pending.length !== 2) return;
  for (const entry of pending.reverse()) {
    const response = entry.method === "test/fail"
      ? { id: entry.id, error: { code: -32000, message: entry.params.owner } }
      : { id: entry.id, result: { owner: entry.params.owner } };
    process.stdout.write(JSON.stringify(response) + "\\n");
  }
});
`,
      );
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
      const shared: CodexAppServerJsonRpcRawMessage[] = [];
      const failed: CodexAppServerJsonRpcRawMessage[] = [];
      const successful: CodexAppServerJsonRpcRawMessage[] = [];
      const logLines: string[] = [];
      const client = await startCodexAppServerClient({
        codexHome: path.join(dir, "auth"),
        onJsonRpcMessage: (message) => shared.push(message),
        log: (line) => logLines.push(line),
      });
      try {
        const results = await Promise.allSettled([
          client.request("test/fail", { owner: "alpha" }, 1_000, {
            onJsonRpcMessage: (message) => {
              failed.push(message);
              if (throws) throw new Error("raw observer failed");
            },
          }),
          client.request("test/succeed", { owner: "beta" }, 1_000, {
            onJsonRpcMessage: (message) => {
              successful.push(message);
              if (throws) throw new Error("raw observer failed");
            },
          }),
        ]);
        expect(results[0]).toMatchObject({ status: "rejected", reason: { message: "alpha" } });
        expect(results[1]).toEqual({ status: "fulfilled", value: { owner: "beta" } });
        expect(failed.map((message) => message.direction)).toEqual([
          "client_request",
          "server_response",
        ]);
        expect(successful.map((message) => message.direction)).toEqual([
          "client_request",
          "server_response",
        ]);
        expect(JSON.stringify(failed)).not.toContain("beta");
        expect(JSON.stringify(successful)).not.toContain("alpha");
        expect(shared).toHaveLength(4);
        expect(logLines.some((line) => line.includes("raw request observer failed"))).toBe(throws);
      } finally {
        await client.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("falls back to older request handlers when newest handler declines request", async () => {
    const writes: string[] = [];
    const rawMessages: unknown[] = [];
    const calls: string[] = [];
    const child = {
      writeStdin: (value: string | Uint8Array) => {
        writes.push(String(value));
      },
    } as Parameters<typeof __internal.respondToServerRequest>[0];
    const handlers: Parameters<typeof __internal.respondToServerRequest>[2] = new Set([
      () => {
        calls.push("parent");
        return { handledBy: "parent" };
      },
      () => {
        calls.push("child");
        return UNHANDLED_CODEX_APP_SERVER_REQUEST;
      },
    ]);

    await __internal.respondToServerRequest(
      child,
      {
        id: "srv-parent",
        method: "item/tool/call",
        params: { threadId: "parent-thread", turnId: "parent-turn" },
      },
      handlers,
      (message) => rawMessages.push(message),
    );

    expect(calls).toEqual(["child", "parent"]);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      id: "srv-parent",
      result: { handledBy: "parent" },
    });
    expect(rawMessages).toEqual([
      {
        direction: "client_response",
        message: { id: "srv-parent", result: { handledBy: "parent" } },
      },
    ]);
  });

  function makeStubClient(): CodexAppServerClient {
    return {
      command: { command: "mock-codex-app-server", args: [], source: "override" },
      isClosed: () => false,
      request: async () => ({ userAgent: "mock" }),
      notify: () => {},
      interruptTurn: async () => {},
      onNotification: () => () => {},
      onServerRequest: () => () => {},
      onJsonRpcMessage: () => () => {},
      onClose: () => () => {},
      close: async () => {},
    };
  }

  test("pooled client startup syncs the Windows sandbox setup state for its CODEX_HOME", async () => {
    const home = await makeTmpHome();
    process.env.HOME = home;
    const codexHome = path.join(home, "custom-codex-home");
    const syncCalls: string[] = [];
    __internal.setSandboxSetupStateSyncForTests(async (homeArg) => {
      syncCalls.push(homeArg);
    });
    __internal.setClientFactoryForTests(async () => makeStubClient());

    const client = await getPooledCodexAppServerClient({ codexHome });

    expect(client.isClosed()).toBe(false);
    expect(syncCalls).toEqual([codexHome]);
  });

  test("a failing sandbox setup sync does not block the pooled client", async () => {
    const home = await makeTmpHome();
    process.env.HOME = home;
    __internal.setSandboxSetupStateSyncForTests(async () => {
      throw new Error("sync broke");
    });
    __internal.setClientFactoryForTests(async () => makeStubClient());

    const client = await getPooledCodexAppServerClient({
      codexHome: path.join(home, "custom-codex-home"),
    });

    expect(client.isClosed()).toBe(false);
  });
});
