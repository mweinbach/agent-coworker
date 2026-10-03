import { describe, expect, test } from "bun:test";

import { dispatchJsonRpcMessage } from "../src/server/jsonrpc/dispatchJsonRpcMessage";
import {
  JSONRPC_ERROR_CODES,
  JSONRPC_PROTOCOL_VERSION,
  type JsonRpcLiteClientResponse,
  type JsonRpcLiteNotification,
  type JsonRpcLiteRequest,
} from "../src/server/jsonrpc/protocol";
import type { StartServerSocket } from "../src/server/startServer/types";

type RpcState = NonNullable<StartServerSocket["data"]["rpc"]>;

function createRpc(overrides: Partial<RpcState> = {}): RpcState {
  return {
    initializeRequestReceived: false,
    initializedNotificationReceived: false,
    pendingRequestCount: 0,
    maxPendingRequests: 32,
    capabilities: {
      experimentalApi: false,
      toolRetryLineage: false,
      optOutNotificationMethods: [],
    },
    pendingServerRequests: new Map(),
    ...overrides,
  };
}

function createSocket(rpc?: RpcState) {
  const payloads: unknown[] = [];
  const ws = {
    data: {
      protocolMode: "jsonrpc" as const,
      selectedSubprotocol: "cowork.v1",
      rpc,
    },
    send() {},
  } as unknown as StartServerSocket;

  return {
    ws,
    payloads,
    send(_socket: StartServerSocket, payload: unknown) {
      payloads.push(payload);
    },
  };
}

function initializeParams(overrides: Record<string, unknown> = {}) {
  return {
    clientInfo: { name: "desktop", version: "1.0.0" },
    ...overrides,
  };
}

describe("dispatchJsonRpcMessage handshake", () => {
  test("missing connection state fails closed for requests and responses, and ignores notifications", () => {
    const { ws, payloads, send } = createSocket();
    const requests: JsonRpcLiteRequest[] = [];
    const notifications: JsonRpcLiteNotification[] = [];

    dispatchJsonRpcMessage({
      ws,
      message: { id: 1, method: "initialize", params: initializeParams() },
      send,
      onRequest: (message) => requests.push(message),
    });
    dispatchJsonRpcMessage({
      ws,
      message: { id: 2, result: { ok: true } },
      send,
    });
    dispatchJsonRpcMessage({
      ws,
      message: { method: "initialized" },
      send,
      onNotification: (message) => notifications.push(message),
    });

    expect(payloads).toEqual([
      {
        id: 1,
        error: {
          code: JSONRPC_ERROR_CODES.internalError,
          message: "Missing JSON-RPC connection state",
        },
      },
      {
        id: 2,
        error: {
          code: JSONRPC_ERROR_CODES.internalError,
          message: "Missing JSON-RPC connection state",
        },
      },
    ]);
    expect(requests).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test("initialize must be a request and cannot run twice", () => {
    const rpc = createRpc();
    const { ws, payloads, send } = createSocket(rpc);

    dispatchJsonRpcMessage({
      ws,
      message: { method: "initialize", params: initializeParams() },
      send,
    });
    expect(payloads[0]).toEqual({
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: "initialize must be sent as a request",
      },
    });
    expect(rpc.initializeRequestReceived).toBe(false);

    dispatchJsonRpcMessage({
      ws,
      message: { id: "init-1", method: "initialize", params: { extra: true } },
      send,
    });
    expect(payloads[1]).toEqual(
      expect.objectContaining({
        id: "init-1",
        error: expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidParams,
        }),
      }),
    );
    expect(rpc.initializeRequestReceived).toBe(false);

    dispatchJsonRpcMessage({
      ws,
      message: {
        id: "init-2",
        method: "initialize",
        params: initializeParams({
          capabilities: { experimentalApi: true, toolRetryLineage: true },
        }),
      },
      send,
    });
    expect(payloads[2]).toEqual({
      id: "init-2",
      result: {
        protocolVersion: JSONRPC_PROTOCOL_VERSION,
        serverInfo: { name: "cowork", subprotocol: "cowork.v1" },
        capabilities: { experimentalApi: true, toolRetryLineage: true },
        transport: { type: "websocket", protocolMode: "jsonrpc" },
      },
    });
    expect(rpc.initializeRequestReceived).toBe(true);
    expect(rpc.capabilities.toolRetryLineage).toBe(true);

    dispatchJsonRpcMessage({
      ws,
      message: { id: "init-3", method: "initialize", params: initializeParams() },
      send,
    });
    expect(payloads[3]).toEqual({
      id: "init-3",
      error: {
        code: JSONRPC_ERROR_CODES.alreadyInitialized,
        message: "Already initialized",
      },
    });
  });

  test("initialized and later methods stay gated until both handshake steps succeed", () => {
    const rpc = createRpc();
    const { ws, payloads, send } = createSocket(rpc);
    const requests: JsonRpcLiteRequest[] = [];
    const notifications: JsonRpcLiteNotification[] = [];
    const responses: JsonRpcLiteClientResponse[] = [];

    dispatchJsonRpcMessage({
      ws,
      message: { method: "initialized" },
      send,
    });
    expect(payloads[0]).toEqual({
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.notInitialized,
        message: "Not initialized",
      },
    });

    dispatchJsonRpcMessage({
      ws,
      message: { id: "turn-1", method: "cowork/thread/start", params: {} },
      send,
      onRequest: (message) => requests.push(message),
    });
    expect(payloads[1]).toEqual({
      id: "turn-1",
      error: {
        code: JSONRPC_ERROR_CODES.notInitialized,
        message: "Not initialized",
      },
    });

    dispatchJsonRpcMessage({
      ws,
      message: { id: "init-1", method: "initialize", params: initializeParams() },
      send,
    });
    dispatchJsonRpcMessage({
      ws,
      message: { method: "initialized", params: { extra: true } },
      send,
    });
    expect(payloads[3]).toEqual(
      expect.objectContaining({
        id: null,
        error: expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidParams,
        }),
      }),
    );
    expect(rpc.initializedNotificationReceived).toBe(false);

    dispatchJsonRpcMessage({
      ws,
      message: { id: "ready-1", method: "initialized" },
      send,
    });
    expect(payloads[4]).toEqual({ id: "ready-1", result: {} });
    expect(rpc.initializedNotificationReceived).toBe(true);

    dispatchJsonRpcMessage({
      ws,
      message: { id: "turn-2", method: "cowork/thread/start", params: { title: "hi" } },
      send,
      onRequest: (message) => requests.push(message),
    });
    dispatchJsonRpcMessage({
      ws,
      message: { method: "cowork/session/ping" },
      send,
      onNotification: (message) => notifications.push(message),
    });
    dispatchJsonRpcMessage({
      ws,
      message: { id: "ask-1", result: { answers: [] } },
      send,
      onResponse: (message) => responses.push(message),
    });

    expect(requests).toEqual([
      { id: "turn-2", method: "cowork/thread/start", params: { title: "hi" } },
    ]);
    expect(notifications).toEqual([{ method: "cowork/session/ping" }]);
    expect(responses).toEqual([{ id: "ask-1", result: { answers: [] } }]);
  });

  test("initialized handshake without an onRequest handler reports methodNotFound", () => {
    const rpc = createRpc({
      initializeRequestReceived: true,
      initializedNotificationReceived: true,
    });
    const { ws, payloads, send } = createSocket(rpc);

    dispatchJsonRpcMessage({
      ws,
      message: { id: 9, method: "cowork/unknown" },
      send,
    });

    expect(payloads).toEqual([
      {
        id: 9,
        error: {
          code: JSONRPC_ERROR_CODES.methodNotFound,
          message: "Unknown method: cowork/unknown",
        },
      },
    ]);
  });
});
