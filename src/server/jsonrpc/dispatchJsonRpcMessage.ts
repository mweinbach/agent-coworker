import type { StartServerSocket } from "../startServer/types";

import {
  buildJsonRpcErrorResponse,
  buildJsonRpcResultResponse,
  JSONRPC_ERROR_CODES,
  JSONRPC_PROTOCOL_VERSION,
  parseInitializeParams,
  parseInitializedParams,
  type JsonRpcLiteClientResponse,
  type JsonRpcLiteNotification,
  type JsonRpcLiteRequest,
} from "./protocol";

type DispatchJsonRpcMessageArgs = {
  ws: StartServerSocket;
  message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse;
  onRequest?: (message: JsonRpcLiteRequest) => void;
  onNotification?: (message: JsonRpcLiteNotification) => void;
  onResponse?: (message: JsonRpcLiteClientResponse) => void;
};

function sendJsonRpc(ws: StartServerSocket, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function isJsonRpcRequest(
  message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
): message is JsonRpcLiteRequest {
  return "id" in message && "method" in message;
}

function isJsonRpcResponse(
  message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
): message is JsonRpcLiteClientResponse {
  return "id" in message && !("method" in message);
}

export function dispatchJsonRpcMessage({ ws, message, onRequest, onNotification, onResponse }: DispatchJsonRpcMessageArgs): void {
  const rpc = ws.data.rpc;
  if (!rpc) {
    if (isJsonRpcRequest(message) || isJsonRpcResponse(message)) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, {
        code: JSONRPC_ERROR_CODES.internalError,
        message: "Missing JSON-RPC connection state",
      }));
    }
    return;
  }

  if (isJsonRpcResponse(message)) {
    onResponse?.(message);
    return;
  }

  if (message.method === "initialize") {
    if (!isJsonRpcRequest(message)) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(null, {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: "initialize must be sent as a request",
      }));
      return;
    }
    if (rpc.initializeRequestReceived) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, {
        code: JSONRPC_ERROR_CODES.alreadyInitialized,
        message: "Already initialized",
      }));
      return;
    }
    const parsed = parseInitializeParams(message.params);
    if (!parsed.ok) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, parsed.error));
      return;
    }
    rpc.initializeRequestReceived = true;
    rpc.clientInfo = parsed.params.clientInfo;
    rpc.capabilities = {
      experimentalApi: parsed.params.capabilities?.experimentalApi === true,
      optOutNotificationMethods: [...(parsed.params.capabilities?.optOutNotificationMethods ?? [])],
    };
    sendJsonRpc(ws, buildJsonRpcResultResponse(message.id, {
      protocolVersion: JSONRPC_PROTOCOL_VERSION,
      serverInfo: {
        name: "cowork",
        subprotocol: ws.data.selectedSubprotocol ?? undefined,
      },
      capabilities: {
        experimentalApi: true,
      },
      transport: {
        type: "websocket",
        protocolMode: ws.data.protocolMode ?? "jsonrpc",
      },
    }));
    return;
  }

  if (message.method === "initialized") {
    const parsed = parseInitializedParams(message.params);
    if (!parsed.ok) {
      if (isJsonRpcRequest(message)) {
        sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, parsed.error));
      } else {
        sendJsonRpc(ws, buildJsonRpcErrorResponse(null, parsed.error));
      }
      return;
    }
    if (!rpc.initializeRequestReceived) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(isJsonRpcRequest(message) ? message.id : null, {
        code: JSONRPC_ERROR_CODES.notInitialized,
        message: "Not initialized",
      }));
      return;
    }
    rpc.initializedNotificationReceived = true;
    if (isJsonRpcRequest(message)) {
      sendJsonRpc(ws, buildJsonRpcResultResponse(message.id, {}));
    }
    return;
  }

  if (!rpc.initializeRequestReceived || !rpc.initializedNotificationReceived) {
    if (isJsonRpcRequest(message)) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, {
        code: JSONRPC_ERROR_CODES.notInitialized,
        message: "Not initialized",
      }));
    } else {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(null, {
        code: JSONRPC_ERROR_CODES.notInitialized,
        message: "Not initialized",
      }));
    }
    return;
  }

  if (!isJsonRpcRequest(message)) {
    onNotification?.(message);
    return;
  }

  if (onRequest) {
    onRequest(message);
    return;
  }

  sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, {
    code: JSONRPC_ERROR_CODES.methodNotFound,
    message: `Unknown method: ${message.method}`,
  }));
}
