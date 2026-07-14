import type { AgentServerRuntime } from "../runtime/ServerRuntime";
import {
  createHttpJsonRpcConnection,
  dispatchHttpRpcMessage,
  type HttpJsonRpcConnection,
  jsonResponse,
} from "./httpJsonRpcConnection";

export const LOOPBACK_CLIENT_ID_HEADER = "x-cowork-client-id";

export type LoopbackHttpRpcSession = {
  getOrCreate(clientId: string): HttpJsonRpcConnection;
  close(clientId: string): void;
  closeAll(): void;
};

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export function createLoopbackHttpRpcSession(runtime: AgentServerRuntime): LoopbackHttpRpcSession {
  const connections = new Map<string, HttpJsonRpcConnection>();
  return {
    getOrCreate(clientId: string) {
      const existing = connections.get(clientId);
      if (existing) {
        return existing;
      }
      const connection = createHttpJsonRpcConnection(runtime, {
        protocolMode: "jsonrpc",
        transportType: "http",
        selectedSubprotocol: "cowork.jsonrpc.v1",
      });
      connections.set(clientId, connection);
      return connection;
    },
    close(clientId: string) {
      const connection = connections.get(clientId);
      if (!connection) {
        return;
      }
      connections.delete(clientId);
      connection.close();
    },
    closeAll() {
      for (const connection of connections.values()) {
        connection.close();
      }
      connections.clear();
    },
  };
}

export function assertLoopbackRpcRemote(
  req: Request,
  server: { requestIP?: (request: Request) => { address: string } | null },
): Response | null {
  const ip = typeof server.requestIP === "function" ? server.requestIP(req) : null;
  // Bun may omit requestIP for some local harness paths; require an explicit
  // loopback address when the runtime reports one.
  if (ip && !isLoopbackAddress(ip.address)) {
    return jsonResponse(
      { error: "Loopback HTTP RPC is restricted to local clients." },
      { status: 403 },
    );
  }
  return null;
}

export async function handleLoopbackHttpRpc(
  req: Request,
  session: LoopbackHttpRpcSession,
  options?: {
    corsHeaders?: Record<string, string>;
  },
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      { status: 405, headers: options?.corsHeaders },
    );
  }

  const clientId = req.headers.get(LOOPBACK_CLIENT_ID_HEADER)?.trim();
  if (!clientId) {
    return jsonResponse(
      { error: `Missing ${LOOPBACK_CLIENT_ID_HEADER} header.` },
      { status: 400, headers: options?.corsHeaders },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse(
      { error: "Invalid JSON body." },
      { status: 400, headers: options?.corsHeaders },
    );
  }

  const connection = session.getOrCreate(clientId);
  const response = await dispatchHttpRpcMessage(raw, connection);
  if (!options?.corsHeaders) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(options.corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
