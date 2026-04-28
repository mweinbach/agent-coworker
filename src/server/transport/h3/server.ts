import {
  type CoworkPairingTicket,
  decodeCoworkPairingTicket,
  encodeCoworkPairingTicket,
} from "../../../shared/coworkTicket";
import { createEphemeralQuicCertificate } from "../../../shared/quicCert";
import type {
  JsonRpcLiteClientResponse,
  JsonRpcLiteNotification,
  JsonRpcLiteRequest,
} from "../../jsonrpc/protocol";
import type { AgentServerRuntime } from "../../runtime/ServerRuntime";
import type { StartServerSocketData } from "../../startServer/types";
import {
  createH3PairingSession,
  forgetH3TrustedDevice,
  forgetH3TrustedDevices,
  type H3PairingSession,
  type H3TrustedDeviceRecord,
  loadH3PairingStoreState,
  rememberH3TrustedDevice,
  verifyH3SessionToken,
} from "./pairing";

type H3Connection = {
  data: StartServerSocketData;
  send(message: string): number;
};

type H3JsonRpcConnection = H3Connection & {
  addEventSink(controller: ReadableStreamDefaultController<Uint8Array>): () => void;
  dispatch(
    message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
  ): Promise<unknown | null>;
  close(): void;
};

const HTTP_RPC_RESPONSE_TIMEOUT_MS = 30_000;

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
  adminToken: string;
  certSha256: string;
  spkiSha256: string;
  identityPub: string;
  nonce: string;
  expiresAt: number;
  trustedDevice: H3MobileTrustedDeviceSummary | null;
};

type H3MobileServerHandle = H3MobileServerState & {
  server: ReturnType<typeof Bun.serve>;
  revokeTrustedDevice(deviceId: string): Promise<boolean>;
  revokeTrustedDevices(): Promise<void>;
  stop(): Promise<void>;
};

type H3MobileTrustedDeviceSummary = {
  deviceId: string;
  fingerprint: string;
  displayName: string | null;
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

function formatUrlHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function requireAdminToken(req: Request, adminToken: string): Response | null {
  if (parseBearerToken(req.headers.get("authorization")) === adminToken) {
    return null;
  }
  return jsonResponse({ error: "Unauthorized." }, { status: 401 });
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

async function dispatchHttpRpcPayload(
  raw: unknown,
  connection: H3JsonRpcConnection,
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
    return jsonResponse({ ok: true }, { status: 202 });
  }
  return jsonResponse(response ?? {});
}

function decodePairingTicketForRequest(rawTicket: string): CoworkPairingTicket | null {
  try {
    return decodeCoworkPairingTicket(rawTicket);
  } catch {
    return null;
  }
}

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

function createHttpJsonRpcConnection(runtime: AgentServerRuntime): H3JsonRpcConnection {
  const encoder = new TextEncoder();
  const pendingResponses = new Map<
    string,
    { resolve(payload: unknown): void; reject(error: Error): void }
  >();
  const eventSinks = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const connection: H3Connection = {
    data: {
      connectionId: crypto.randomUUID(),
      protocolMode: "jsonrpc",
      selectedSubprotocol: "cowork.jsonrpc.v1",
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
  };
  runtime.openHttpConnection(connection as never);
  return Object.assign(connection, {
    addEventSink(controller: ReadableStreamDefaultController<Uint8Array>) {
      eventSinks.add(controller);
      controller.enqueue(encoder.encode(": cowork events\n\n"));
      return () => {
        eventSinks.delete(controller);
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
      for (const pending of pendingResponses.values()) {
        pending.reject(new Error("H3 JSON-RPC connection closed."));
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
  });
}

function summarizeTrustedDevice(
  trustedDevice: H3TrustedDeviceRecord | null | undefined,
): H3MobileTrustedDeviceSummary | null {
  if (!trustedDevice) {
    return null;
  }
  return {
    deviceId: trustedDevice.deviceId,
    fingerprint: trustedDevice.fingerprint,
    displayName: trustedDevice.displayName,
  };
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

export async function startH3MobileServer(
  options: StartH3MobileServerOptions,
): Promise<H3MobileServerHandle> {
  const hostname = options.hostname ?? "0.0.0.0";
  const certificate = await createEphemeralQuicCertificate();
  const pairing = createH3PairingSession();
  const hostHints = options.hostHints?.length ? options.hostHints : ["127.0.0.1"];
  const pairingSessions = new Map<string, H3PairingSession>([[pairing.nonce, pairing]]);
  const adminToken = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  const httpConnections = new Map<string, H3JsonRpcConnection>();
  const initialStoreState = await loadH3PairingStoreState(options.storeRootPath);
  let latestTrustedDevice: H3TrustedDeviceRecord | null =
    initialStoreState.trustedDevices[0] ?? null;

  const getConnection = (deviceId: string): H3JsonRpcConnection => {
    const existing = httpConnections.get(deviceId);
    if (existing) {
      return existing;
    }
    const connection = createHttpJsonRpcConnection(options.runtime);
    httpConnections.set(deviceId, connection);
    return connection;
  };

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
      const unauthorized = requireAdminToken(req, adminToken);
      if (unauthorized) return unauthorized;
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
      const decoded = decodePairingTicketForRequest(rawTicket);
      if (!decoded) {
        return jsonResponse({ error: "Invalid pairing request." }, { status: 400 });
      }
      const session = pairingSessions.get(nonce);
      if (!session || decoded.nonce !== nonce || session.expiresAt < Date.now()) {
        return jsonResponse({ error: "Pairing session expired." }, { status: 401 });
      }
      const sessionToken = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
      const trustedDevice = await rememberH3TrustedDevice(options.storeRootPath, {
        deviceId,
        identityPub,
        displayName,
        sessionToken,
      });
      pairingSessions.delete(nonce);
      latestTrustedDevice = trustedDevice;
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

      if (req.method === "POST" && url.pathname === "/rpc") {
        const raw = await req.json().catch(() => null);
        return await dispatchHttpRpcPayload(raw, getConnection(trustedDevice.deviceId));
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const connection = getConnection(trustedDevice.deviceId);
        let removeSink: (() => void) | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            removeSink = connection.addEventSink(controller);
          },
          cancel() {
            removeSink?.();
            httpConnections.delete(trustedDevice.deviceId);
            connection.close();
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
    url: `https://${formatUrlHost(hostHints[0] ?? "127.0.0.1")}:${port}`,
    port,
    hostHints,
    ticket,
    ticketUrl: encodeCoworkPairingTicket(ticket),
    adminToken,
    certSha256: certificate.certSha256,
    spkiSha256: certificate.spkiSha256,
    identityPub: certificate.identityPub,
    nonce: pairing.nonce,
    expiresAt: pairing.expiresAt,
    trustedDevice: summarizeTrustedDevice(latestTrustedDevice),
    async revokeTrustedDevice(deviceId: string) {
      const connection = httpConnections.get(deviceId);
      if (connection) {
        httpConnections.delete(deviceId);
        connection.close();
      }
      const removed = await forgetH3TrustedDevice(options.storeRootPath, deviceId);
      if (latestTrustedDevice?.deviceId === deviceId) {
        const state = await loadH3PairingStoreState(options.storeRootPath);
        latestTrustedDevice = state.trustedDevices[0] ?? null;
      }
      return removed;
    },
    async revokeTrustedDevices() {
      for (const connection of httpConnections.values()) {
        connection.close();
      }
      httpConnections.clear();
      await forgetH3TrustedDevices(options.storeRootPath);
      latestTrustedDevice = null;
    },
    async stop() {
      for (const connection of httpConnections.values()) {
        connection.close();
      }
      httpConnections.clear();
      await server.stop(true);
    },
  };
}

export const __internal = {
  createHttpJsonRpcConnection,
  decodePairingTicketForRequest,
  dispatchHttpRpcPayload,
  formatUrlHost,
  requireAdminToken,
};
