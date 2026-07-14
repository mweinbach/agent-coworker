import type {
  JsonRpcLiteClientResponse,
  JsonRpcLiteNotification,
  JsonRpcLiteRequest,
} from "../jsonrpc/protocol";
import type { AgentServerRuntime } from "../runtime/ServerRuntime";
import type { StartServerSocketData } from "../startServer/types";

export const HTTP_RPC_RESPONSE_TIMEOUT_MS = 30_000;
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export type HttpJsonRpcConnection = {
  data: StartServerSocketData;
  send(message: string): number;
  addEventSink(controller: ReadableStreamDefaultController<Uint8Array>): () => void;
  dispatch(
    message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
  ): Promise<unknown | null>;
  close(): void;
};

export type CreateHttpJsonRpcConnectionOptions = {
  keepaliveIntervalMs?: number;
  protocolMode?: StartServerSocketData["protocolMode"];
  transportType?: StartServerSocketData["transportType"];
  selectedSubprotocol?: string | null;
};

function getJsonRpcIdKey(message: JsonRpcLiteRequest | JsonRpcLiteClientResponse): string {
  return `${typeof message.id}:${String(message.id)}`;
}

function tryParseJsonRpcSendPayload(message: string): unknown {
  try {
    return JSON.parse(message) as unknown;
  } catch {
    return message;
  }
}

async function withResponseTimeout(response: Promise<unknown>): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      response,
      new Promise<unknown>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for JSON-RPC response."));
        }, HTTP_RPC_RESPONSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function parseJsonRpcPayload(
  raw: unknown,
): JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("JSON-RPC payload must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if ("id" in record && !("method" in record)) {
    if (typeof record.id !== "string" && typeof record.id !== "number") {
      throw new Error("JSON-RPC response id must be a string or number.");
    }
    return {
      id: record.id,
      result: record.result,
      error: record.error as never,
    };
  }
  if (!("method" in record) || typeof record.method !== "string" || record.method.trim() === "") {
    throw new Error("JSON-RPC method is required.");
  }
  if ("id" in record) {
    if (typeof record.id !== "string" && typeof record.id !== "number") {
      throw new Error("JSON-RPC id must be a string or number.");
    }
    return {
      id: record.id,
      method: record.method,
      params: record.params,
    };
  }
  return {
    method: record.method,
    params: record.params,
  };
}

export function createHttpJsonRpcConnection(
  runtime: AgentServerRuntime,
  options?: CreateHttpJsonRpcConnectionOptions,
): HttpJsonRpcConnection {
  const encoder = new TextEncoder();
  const keepaliveIntervalMs = options?.keepaliveIntervalMs ?? SSE_KEEPALIVE_INTERVAL_MS;
  const pendingResponses = new Map<
    string,
    { resolve(payload: unknown): void; reject(error: Error): void }
  >();
  const eventSinks = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const stopKeepalive = () => {
    if (!keepaliveTimer) {
      return;
    }
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  };

  const sendKeepalive = () => {
    for (const sink of eventSinks) {
      try {
        sink.enqueue(encoder.encode(": keepalive\n\n"));
      } catch {
        eventSinks.delete(sink);
      }
    }
  };

  const syncKeepalive = () => {
    if (eventSinks.size === 0) {
      stopKeepalive();
      return;
    }
    if (keepaliveTimer) {
      return;
    }
    keepaliveTimer = setInterval(sendKeepalive, keepaliveIntervalMs);
    (keepaliveTimer as { unref?: () => void }).unref?.();
  };

  const connection: HttpJsonRpcConnection = {
    data: {
      connectionId: crypto.randomUUID(),
      protocolMode: options?.protocolMode ?? "h3",
      transportType: options?.transportType,
      selectedSubprotocol: options?.selectedSubprotocol ?? "cowork.jsonrpc.v1",
      workspaceControlEventsAllowed: options?.transportType === "http",
      taskReadAllowed: options?.transportType === "http" ? true : undefined,
      taskMutationAllowed: options?.transportType === "http" ? true : undefined,
    },
    send(message: string) {
      const payload = tryParseJsonRpcSendPayload(message);
      if (payload && typeof payload === "object" && !Array.isArray(payload) && "id" in payload) {
        const response = payload as JsonRpcLiteClientResponse;
        const pending = pendingResponses.get(getJsonRpcIdKey(response));
        if (pending) {
          pendingResponses.delete(getJsonRpcIdKey(response));
          pending.resolve(payload);
          return 1;
        }
      }
      for (const sink of eventSinks) {
        try {
          sink.enqueue(encoder.encode(`data: ${message}\n\n`));
        } catch {
          eventSinks.delete(sink);
        }
      }
      return 1;
    },
    addEventSink(controller: ReadableStreamDefaultController<Uint8Array>) {
      eventSinks.add(controller);
      controller.enqueue(encoder.encode(": cowork events\n\n"));
      syncKeepalive();
      return () => {
        eventSinks.delete(controller);
        syncKeepalive();
      };
    },
    async dispatch(
      message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
    ) {
      if (!("method" in message)) {
        runtime.handleDecodedMessage(connection as never, message);
        return null;
      }
      if (!("id" in message)) {
        runtime.handleDecodedMessage(connection as never, message);
        return null;
      }
      const idKey = getJsonRpcIdKey(message);
      const responsePromise = new Promise<unknown>((resolve, reject) => {
        pendingResponses.set(idKey, { resolve, reject });
      });
      runtime.handleDecodedMessage(connection as never, message);
      try {
        return await withResponseTimeout(responsePromise);
      } finally {
        pendingResponses.delete(idKey);
      }
    },
    close() {
      stopKeepalive();
      for (const pending of pendingResponses.values()) {
        pending.reject(new Error("HTTP JSON-RPC connection closed."));
      }
      pendingResponses.clear();
      for (const sink of eventSinks) {
        try {
          sink.close();
        } catch {
          // The stream may already be canceled by the client.
        }
      }
      eventSinks.clear();
      runtime.closeConnection(connection as never);
    },
  };
  runtime.openHttpConnection(connection as never);
  return connection;
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export async function dispatchHttpRpcMessage(
  raw: unknown,
  connection: HttpJsonRpcConnection,
): Promise<Response> {
  let message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse;
  try {
    message = parseJsonRpcPayload(raw);
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Invalid JSON-RPC payload.",
      },
      { status: 400 },
    );
  }

  let response: unknown | null;
  try {
    response = await connection.dispatch(message);
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "JSON-RPC connection closed.",
      },
      { status: 503 },
    );
  }
  if (!("method" in message) || !("id" in message)) {
    return new Response(null, { status: 202 });
  }
  return jsonResponse(response ?? {});
}
