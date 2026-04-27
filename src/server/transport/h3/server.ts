import type { AgentServerRuntime } from "../../runtime/ServerRuntime";
import type { StartServerSocketData } from "../../startServer/types";
import {
  type JsonRpcLiteClientResponse,
  type JsonRpcLiteNotification,
  type JsonRpcLiteRequest,
} from "../../jsonrpc/protocol";
import {
  decodeCoworkPairingTicket,
  encodeCoworkPairingTicket,
  type CoworkPairingTicket,
} from "../../../shared/coworkTicket";
import { createEphemeralQuicCertificate } from "../../../shared/quicCert";
import {
  createH3PairingSession,
  rememberH3TrustedDevice,
  verifyH3SessionToken,
  type H3PairingSession,
} from "./pairing";

type H3Connection = {
  data: StartServerSocketData;
  send(message: string): number;
};

type H3JsonRpcConnection = H3Connection & {
  getResponsePayload(): unknown;
};

type StartH3MobileServerOptions = {
  runtime: AgentServerRuntime;
  hostname?: string;
  port?: number;
  hostHints?: string[];
  storeRootPath?: string;
  enableH3?: boolean;
};

export type H3MobileServerState = {
  url: string;
  port: number;
  hostHints: string[];
  ticket: CoworkPairingTicket;
  ticketUrl: string;
  certSha256: string;
  spkiSha256: string;
  expiresAt: number;
};

type H3MobileServerHandle = H3MobileServerState & {
  server: ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function parseJsonRpcPayload(
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

function createHttpJsonRpcConnection(runtime: AgentServerRuntime): H3JsonRpcConnection {
  let responsePayload: unknown = null;
  const connection: H3Connection = {
    data: {
      connectionId: crypto.randomUUID(),
      protocolMode: "jsonrpc",
      selectedSubprotocol: "cowork.jsonrpc.v1",
    },
    send(message: string) {
      try {
        responsePayload = JSON.parse(message) as unknown;
        return 1;
      } catch {
        responsePayload = message;
        return 1;
      }
    },
  };
  runtime.openHttpConnection(connection as never);
  return Object.assign(connection, {
    getResponsePayload() {
      return responsePayload;
    },
  });
}

function createSseConnection(runtime: AgentServerRuntime, controller: ReadableStreamDefaultController<Uint8Array>): H3Connection {
  const encoder = new TextEncoder();
  const connection: H3Connection = {
    data: {
      connectionId: crypto.randomUUID(),
      protocolMode: "jsonrpc",
      selectedSubprotocol: "cowork.jsonrpc.v1",
    },
    send(message: string) {
      controller.enqueue(encoder.encode(`data: ${message}\n\n`));
      return 1;
    },
  };
  runtime.openHttpConnection(connection as never);
  return connection;
}

export async function startH3MobileServer(
  options: StartH3MobileServerOptions,
): Promise<H3MobileServerHandle> {
  const hostname = options.hostname ?? "0.0.0.0";
  const certificate = await createEphemeralQuicCertificate();
  const pairing = createH3PairingSession();
  const hostHints = options.hostHints?.length ? options.hostHints : ["127.0.0.1"];
  const pairingSessions = new Map<string, H3PairingSession>([[pairing.nonce, pairing]]);

  const createTicket = (port: number): CoworkPairingTicket => ({
    v: 1,
    scheme: "h3",
    hosts: hostHints,
    port,
    certSha256: certificate.certSha256,
    spkiSha256: certificate.spkiSha256,
    identityPub: certificate.identityPub,
    nonce: pairing.nonce,
    expiresAt: pairing.expiresAt,
  });

  let server: ReturnType<typeof Bun.serve> | null = null;
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, h3: options.enableH3 !== false });
    }

    if (req.method === "GET" && url.pathname === "/ticket") {
      if (!server) return textResponse("Not ready", { status: 503 });
      const port = server.port;
      if (port === undefined) return textResponse("Not ready", { status: 503 });
      return jsonResponse({ ticket: createTicket(port) });
    }

    if (req.method === "POST" && url.pathname === "/pair") {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const rawTicket = typeof body?.ticket === "string" ? body.ticket : "";
      const nonce = typeof body?.nonce === "string" ? body.nonce : "";
      const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
      const identityPub = typeof body?.identityPub === "string" ? body.identityPub.trim() : "";
      const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : null;
      if (!rawTicket || !nonce || !deviceId || !identityPub) {
        return jsonResponse({ error: "Invalid pairing request." }, { status: 400 });
      }
      const decoded = decodeCoworkPairingTicket(rawTicket);
      const session = pairingSessions.get(nonce);
      if (!session || decoded.nonce !== nonce || session.expiresAt < Date.now()) {
        return jsonResponse({ error: "Pairing session expired." }, { status: 401 });
      }
      pairingSessions.delete(nonce);
      const sessionToken = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
      const trustedDevice = await rememberH3TrustedDevice(options.storeRootPath, {
        deviceId,
        identityPub,
        displayName,
        sessionToken,
      });
      return jsonResponse({
        sessionToken,
        trustedDevice: {
          deviceId: trustedDevice.deviceId,
          fingerprint: trustedDevice.fingerprint,
          displayName: trustedDevice.displayName,
        },
      });
    }

    if (url.pathname === "/rpc" || url.pathname === "/events") {
      const trustedDevice = await verifyH3SessionToken(
        options.storeRootPath,
        parseBearerToken(req.headers.get("authorization")),
      );
      if (!trustedDevice) {
        return jsonResponse({ error: "Unauthorized." }, { status: 401 });
      }
    }

    if (req.method === "POST" && url.pathname === "/rpc") {
      const raw = await req.json().catch(() => null);
      const message = parseJsonRpcPayload(raw);
      const connection = createHttpJsonRpcConnection(options.runtime) as H3Connection & {
        getResponsePayload(): unknown;
      };
      try {
        options.runtime.handleDecodedMessage(connection as never, message);
        await Promise.resolve();
        return jsonResponse(connection.getResponsePayload() ?? {});
      } finally {
        options.runtime.closeConnection(connection as never);
      }
    }

    if (req.method === "GET" && url.pathname === "/events") {
      let connection: H3Connection | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          connection = createSseConnection(options.runtime, controller);
          controller.enqueue(new TextEncoder().encode(": cowork events\n\n"));
        },
        cancel() {
          if (connection) options.runtime.closeConnection(connection as never);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    return textResponse("Not found", { status: 404 });
  };

  server = Bun.serve<StartServerSocketData>({
    hostname,
    port: options.port ?? 0,
    tls: {
      cert: certificate.certPem,
      key: certificate.keyPem,
    },
    ...(options.enableH3 === false ? {} : { h3: true }),
    fetch,
  });

  const port = server.port;
  if (port === undefined) {
    await server.stop(true);
    throw new Error("H3 mobile server did not bind to a port.");
  }
  const ticket = createTicket(port);
  return {
    server,
    url: `https://${hostHints[0] ?? "127.0.0.1"}:${port}`,
    port,
    hostHints,
    ticket,
    ticketUrl: encodeCoworkPairingTicket(ticket),
    certSha256: certificate.certSha256,
    spkiSha256: certificate.spkiSha256,
    expiresAt: pairing.expiresAt,
    async stop() {
      await server.stop(true);
    },
  };
}
