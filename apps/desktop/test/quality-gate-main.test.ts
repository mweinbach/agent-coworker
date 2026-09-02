import { afterAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { jsonRpcControlResultSchemas } from "../../../src/shared/jsonrpcControlSchemas";

import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";

class FixtureSocket extends EventEmitter {
  readyState = 1;
  messages: unknown[] = [];

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  send(message: string) {
    this.messages.push(JSON.parse(message));
  }
}

let server: EventEmitter;
const scratchRoot = scratchRoots()[0];
const fakeApp = {
  setName: () => {},
  setPath: () => {},
  getPath: () => scratchRoot,
  commandLine: { appendSwitch: () => {} },
  whenReady: () => new Promise<void>(() => {}),
  on: () => {},
};
mock.module("electron", () => ({
  app: fakeApp,
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
  nativeTheme: {},
  session: {},
}));
mock.module("ws", () => ({
  WebSocket: { OPEN: 1 },
  WebSocketServer: class extends EventEmitter {
    constructor() {
      super();
      server = this;
      queueMicrotask(() => this.emit("listening"));
    }

    address() {
      return { port: 7_337 };
    }
  },
}));

const previousEnvironment = { ...process.env };
const previousUncaught = process.listeners("uncaughtException");
const previousUnhandled = process.listeners("unhandledRejection");
const fixture = await import("../electron/qualityGateMain");

afterAll(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in previousEnvironment)) delete process.env[name];
  }
  Object.assign(process.env, previousEnvironment);
  for (const listener of process.listeners("uncaughtException")) {
    if (!previousUncaught.includes(listener)) process.removeListener("uncaughtException", listener);
  }
  for (const listener of process.listeners("unhandledRejection")) {
    if (!previousUnhandled.includes(listener))
      process.removeListener("unhandledRejection", listener);
  }
  delete globalThis.__coworkQualityGateMain;
});

describe("quality main fixture dispatch", () => {
  test("returns the canonical Codex runtime status envelope for provider settings", () => {
    for (const checkLatest of [false, true]) {
      const result = jsonRpcControlResultSchemas["cowork/provider/codexAppServer/status"].parse(
        fixture.jsonRpcResult("cowork/provider/codexAppServer/status", {
          cwd: "/quality/project",
          checkLatest,
        }),
      );
      expect(result.status).toMatchObject({ available: false, source: "missing" });
      expect(result.status.message).toContain("quality fixture");
    }
  });

  test("rejects an unknown RPC instead of returning a successful empty result", () => {
    expect(() => fixture.jsonRpcResult("thread/not-a-real-operation", {})).toThrow(
      "Unsupported quality-gate JSON-RPC method",
    );
  });

  test("rejects declared but unimplemented destructive IPC", async () => {
    await expect(fixture.handleIpc(DESKTOP_IPC_CHANNELS.trashPath, {}, null)).rejects.toThrow(
      "Unsupported quality-gate IPC channel",
    );
  });

  test("keeps explicitly allowlisted passive fixture traffic", async () => {
    expect(fixture.jsonRpcResult("thread/unsubscribe", {})).toEqual({});
    await expect(
      fixture.handleIpc(DESKTOP_IPC_CHANNELS.captureProductEvent, {}, null),
    ).resolves.toBeUndefined();
  });
});

describe("quality main transport recovery", () => {
  test("closes the old transport and holds the replacement handshake until released", async () => {
    await fixture.startMockServer();
    const original = new FixtureSocket();
    server.emit("connection", original);
    const control = globalThis.__coworkQualityGateMain!;

    await control.disconnectTransport();
    expect(original.readyState).toBe(3);
    const replacement = new FixtureSocket();
    server.emit("connection", replacement);
    replacement.emit("message", JSON.stringify({ id: 1, method: "initialize", params: {} }));
    expect(replacement.messages).toEqual([]);

    control.releaseTransport();
    expect(replacement.messages).toEqual([
      {
        id: 1,
        result: {
          protocolVersion: "0.1",
          serverInfo: { name: "cowork-quality-gate", version: "1.0.0" },
          capabilities: {},
        },
      },
    ]);
    expect(control.getMetrics().activeSocketConnections).toBe(1);
    replacement.close();
  });
});
