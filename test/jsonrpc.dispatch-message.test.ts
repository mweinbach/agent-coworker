import { describe, expect, test } from "bun:test";

import { dispatchJsonRpcMessage } from "../src/server/jsonrpc/dispatchJsonRpcMessage";
import { JSONRPC_ERROR_CODES, JSONRPC_PROTOCOL_VERSION } from "../src/server/jsonrpc/protocol";
import type { StartServerSocket } from "../src/server/startServer/types";

function makeSocket(rpc: StartServerSocket["data"]["rpc"] | null) {
  const sent: unknown[] = [];
  const ws = {
    data: {
      rpc: rpc ?? undefined,
      selectedSubprotocol: "cowork.jsonrpc.v1",
      protocolMode: "jsonrpc" as const,
    },
    send: () => {
      throw new Error("default send should not be used");
    },
  } as unknown as StartServerSocket;
  return {
    ws,
    sent,
    send: (_socket: StartServerSocket, payload: unknown) => {
      sent.push(payload);
    },
  };
}

function freshRpc(): NonNullable<StartServerSocket["data"]["rpc"]> {
  return {
    initializeRequestReceived: false,
    initializedNotificationReceived: false,
    pendingRequestCount: 0,
    maxPendingRequests: 16,
    capabilities: {
      experimentalApi: false,
      toolRetryLineage: false,
      optOutNotificationMethods: [],
    },
    pendingServerRequests: new Map(),
  };
}

describe("dispatchJsonRpcMessage lifecycle gates", () => {
  test("missing connection state fails closed for requests and responses", () => {
    const request = makeSocket(null);
    dispatchJsonRpcMessage({
      ws: request.ws,
      message: { id: 1, method: "thread/list" },
      send: request.send,
    });
    expect(request.sent).toEqual([
      {
        id: 1,
        error: {
          code: JSONRPC_ERROR_CODES.internalError,
          message: "Missing JSON-RPC connection state",
        },
      },
    ]);

    const response = makeSocket(null);
    dispatchJsonRpcMessage({
      ws: response.ws,
      message: { id: "ask-1", result: { answer: "ok" } },
      send: response.send,
    });
    expect(response.sent).toEqual([
      {
        id: "ask-1",
        error: {
          code: JSONRPC_ERROR_CODES.internalError,
          message: "Missing JSON-RPC connection state",
        },
      },
    ]);

    const notification = makeSocket(null);
    dispatchJsonRpcMessage({
      ws: notification.ws,
      message: { method: "initialized" },
      send: notification.send,
    });
    expect(notification.sent).toEqual([]);
  });

  test("rejects initialize sent as a notification and duplicate initialize", () => {
    const notification = makeSocket(freshRpc());
    dispatchJsonRpcMessage({
      ws: notification.ws,
      message: {
        method: "initialize",
        params: { clientInfo: { name: "desktop" } },
      },
      send: notification.send,
    });
    expect(notification.sent).toEqual([
      {
        id: null,
        error: {
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: "initialize must be sent as a request",
        },
      },
    ]);
    expect(notification.ws.data.rpc?.initializeRequestReceived).toBe(false);

    const duplicate = makeSocket({
      ...freshRpc(),
      initializeRequestReceived: true,
    });
    dispatchJsonRpcMessage({
      ws: duplicate.ws,
      message: {
        id: 2,
        method: "initialize",
        params: { clientInfo: { name: "desktop" } },
      },
      send: duplicate.send,
    });
    expect(duplicate.sent).toEqual([
      {
        id: 2,
        error: {
          code: JSONRPC_ERROR_CODES.alreadyInitialized,
          message: "Already initialized",
        },
      },
    ]);
  });

  test("rejects initialized and ordinary RPCs until the handshake completes", () => {
    const rpc = freshRpc();
    const socket = makeSocket(rpc);

    dispatchJsonRpcMessage({
      ws: socket.ws,
      message: { method: "initialized" },
      send: socket.send,
    });
    expect(socket.sent).toEqual([
      {
        id: null,
        error: {
          code: JSONRPC_ERROR_CODES.notInitialized,
          message: "Not initialized",
        },
      },
    ]);
    expect(rpc.initializedNotificationReceived).toBe(false);

    socket.sent.length = 0;
    dispatchJsonRpcMessage({
      ws: socket.ws,
      message: { id: 3, method: "thread/list" },
      send: socket.send,
    });
    expect(socket.sent).toEqual([
      {
        id: 3,
        error: {
          code: JSONRPC_ERROR_CODES.notInitialized,
          message: "Not initialized",
        },
      },
    ]);

    socket.sent.length = 0;
    dispatchJsonRpcMessage({
      ws: socket.ws,
      message: { method: "cowork/ping" },
      send: socket.send,
    });
    expect(socket.sent).toEqual([
      {
        id: null,
        error: {
          code: JSONRPC_ERROR_CODES.notInitialized,
          message: "Not initialized",
        },
      },
    ]);
  });

  test("initialize records capabilities and initialized unlocks later requests", () => {
    const rpc = freshRpc();
    const socket = makeSocket(rpc);
    const requests: Array<{ method: string }> = [];

    dispatchJsonRpcMessage({
      ws: socket.ws,
      message: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "desktop", title: "Desktop", version: "1.2.0" },
          capabilities: {
            experimentalApi: true,
            toolRetryLineage: true,
            optOutNotificationMethods: ["cowork/session/budgetWarning"],
          },
        },
      },
      send: socket.send,
    });

    expect(rpc.initializeRequestReceived).toBe(true);
    expect(rpc.clientInfo).toEqual({
      name: "desktop",
      title: "Desktop",
      version: "1.2.0",
    });
    expect(rpc.capabilities).toEqual({
      experimentalApi: true,
      toolRetryLineage: true,
      optOutNotificationMethods: ["cowork/session/budgetWarning"],
    });
    expect(socket.sent).toEqual([
      {
        id: 1,
        result: {
          protocolVersion: JSONRPC_PROTOCOL_VERSION,
          serverInfo: {
            name: "cowork",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: true,
            toolRetryLineage: true,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      },
    ]);

    socket.sent.length = 0;
    dispatchJsonRpcMessage({
      ws: socket.ws,
      message: { id: 2, method: "initialized" },
      send: socket.send,
      onRequest: (message) => {
        requests.push(message);
      },
    });
    expect(rpc.initializedNotificationReceived).toBe(true);
    expect(socket.sent).toEqual([{ id: 2, result: {} }]);

    socket.sent.length = 0;
    dispatchJsonRpcMessage({
      ws: socket.ws,
      message: { id: 3, method: "thread/list" },
      send: socket.send,
      onRequest: (message) => {
        requests.push(message);
      },
    });
    expect(requests).toEqual([{ id: 3, method: "thread/list" }]);
    expect(socket.sent).toEqual([]);
  });

  test("rejects invalid initialize params before marking the handshake started", () => {
    const rpc = freshRpc();
    const socket = makeSocket(rpc);
    dispatchJsonRpcMessage({
      ws: socket.ws,
      message: {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "  " } },
      },
      send: socket.send,
    });
    expect(rpc.initializeRequestReceived).toBe(false);
    expect(socket.sent).toEqual([
      {
        id: 1,
        error: {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Too small: expected string to have >=1 characters",
        },
      },
    ]);
  });
});
