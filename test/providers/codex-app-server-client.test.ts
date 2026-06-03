import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __internal,
  type CodexAppServerClient,
  type CodexAppServerCloseInfo,
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
  COWORK_SOFFICE: process.env.COWORK_SOFFICE
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
        COWORK_SOFFICE: "/tmp/cowork-managed-bin/soffice",
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
      COWORK_SOFFICE: "/tmp/cowork-managed-bin/soffice",
    });
    expect((await fs.stat(expectedCodexHome)).isDirectory()).toBe(true);
  });

  test("falls back to older request handlers when newest handler declines request", async () => {
    const writes: string[] = [];
    const rawMessages: unknown[] = [];
    const calls: string[] = [];
    const child = {
      stdin: {
        write: (value: string) => {
          writes.push(value);
          return true;
        },
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
});
