import { isDeepStrictEqual } from "node:util";

import {
  type CoworkPairingTicket,
  decodeCoworkPairingTicket,
  encodeCoworkPairingTicket,
} from "../../../shared/coworkTicket";
import type { AgentServerRuntime } from "../../runtime/ServerRuntime";
import type { StartServerSocketData } from "../../startServer/types";
import { parseBearerToken } from "../auth";
import { createHttpJsonRpcConnection, type HttpJsonRpcConnection } from "../httpJsonRpcConnection";
import { jsonResponse } from "../httpResponse";
import { createH3DeviceConnections } from "./deviceConnections";
import { dispatchHttpRpcPayload } from "./jsonRpcDispatch";
import {
  createH3PairingSession,
  DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS,
  findH3TrustedDeviceBySessionToken,
  forgetH3TrustedDevice,
  forgetH3TrustedDevices,
  H3_TRUSTED_DEVICE_PERMISSION_KEYS,
  type H3TrustedDevicePermissionKey,
  type H3TrustedDevicePermissions,
  type H3TrustedDeviceRecord,
  listH3TrustedDevices,
  loadH3PairingStoreState,
  rememberH3TrustedDevice,
  updateH3TrustedDevicePermissions,
  verifyH3PairingNonce,
  verifyH3SessionToken,
} from "./pairing";
import { applyTrustedDevicePermissionsToConnection, getRequiredH3Permission } from "./permissions";
import {
  loadOrCreatePersistedQuicCertificate,
  persistH3ListenerPort,
  resolvePersistedH3Port,
} from "./persistedListener";

const MOBILE_DEVICE_ID_HEADER = "x-cowork-mobile-device-id";

type StartH3MobileServerOptions = {
  runtime: AgentServerRuntime;
  hostname?: string;
  port?: number;
  hostHints?: string[];
  storeRootPath?: string;
  enableH3?: boolean;
  rotateTls?: boolean;
};

type H3MobileServerState = {
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
  trustedDevices: H3MobileTrustedDeviceSummary[];
};

type H3MobileServerHandle = H3MobileServerState & {
  server: ReturnType<typeof Bun.serve>;
  listTrustedDevices(): Promise<H3MobileTrustedDeviceSummary[]>;
  updateTrustedDevicePermissions(
    deviceId: string,
    permissions: Partial<Record<H3TrustedDevicePermissionKey, boolean>>,
  ): Promise<H3MobileTrustedDeviceSummary | null>;
  revokeTrustedDevice(deviceId: string): Promise<boolean>;
  revokeTrustedDevices(): Promise<void>;
  stop(): Promise<void>;
};

type H3MobileTrustedDeviceSummary = {
  deviceId: string;
  fingerprint: string;
  displayName: string | null;
  lastPairedAt: string;
  lastConnectedAt: string | null;
  permissions: H3TrustedDevicePermissions;
};

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

function requireAdminToken(req: Request, adminToken: string): Response | null {
  if (parseBearerToken(req.headers.get("authorization")) === adminToken) {
    return null;
  }
  return jsonResponse({ error: "Unauthorized." }, { status: 401 });
}

type PairingRequest = {
  rawTicket: string;
  nonce: string;
  deviceId: string;
  identityPub: string;
  displayName: string | null;
};

function parsePairingRequestBody(body: unknown): PairingRequest | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const rawTicket = typeof record.ticket === "string" ? record.ticket : "";
  const nonce = typeof record.nonce === "string" ? record.nonce : "";
  const deviceId = typeof record.deviceId === "string" ? record.deviceId.trim() : "";
  const identityPub = typeof record.identityPub === "string" ? record.identityPub.trim() : "";
  const displayName = typeof record.displayName === "string" ? record.displayName.trim() : null;
  if (
    rawTicket.length === 0 ||
    nonce.length === 0 ||
    deviceId.length === 0 ||
    identityPub.length === 0
  ) {
    return null;
  }
  return { rawTicket, nonce, deviceId, identityPub, displayName };
}

function decodePairingTicketForRequest(rawTicket: string): CoworkPairingTicket | null {
  try {
    return decodeCoworkPairingTicket(rawTicket);
  } catch {
    return null;
  }
}

function pairingTicketMatchesExpected(
  actual: CoworkPairingTicket,
  expected: CoworkPairingTicket,
): boolean {
  return isDeepStrictEqual(actual, expected);
}

function createH3HttpJsonRpcConnection(
  runtime: AgentServerRuntime,
  options?: { keepaliveIntervalMs?: number },
): HttpJsonRpcConnection {
  return createHttpJsonRpcConnection(runtime, {
    keepaliveIntervalMs: options?.keepaliveIntervalMs,
    protocolMode: "h3",
    transportType: "h3",
    selectedSubprotocol: "cowork.jsonrpc.v1",
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
    lastPairedAt: trustedDevice.lastPairedAt,
    lastConnectedAt: trustedDevice.lastConnectedAt,
    permissions: { ...trustedDevice.permissions },
  };
}

async function summarizeTrustedDevices(
  storeRootPath: string | undefined,
): Promise<H3MobileTrustedDeviceSummary[]> {
  return (await listH3TrustedDevices(storeRootPath))
    .map(summarizeTrustedDevice)
    .filter((device): device is H3MobileTrustedDeviceSummary => device !== null);
}

export async function startH3MobileServer(
  options: StartH3MobileServerOptions,
): Promise<H3MobileServerHandle> {
  const hostname = options.hostname ?? "0.0.0.0";
  const certificate = await loadOrCreatePersistedQuicCertificate(options.storeRootPath, {
    forceRotate: options.rotateTls === true,
  });
  const preferredPort = await resolvePersistedH3Port(options.storeRootPath, options.port);
  const pairing = createH3PairingSession();
  const hostHints = options.hostHints?.length ? options.hostHints : ["127.0.0.1"];
  let pairingConsumed = false;
  const adminToken = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  const deviceConnections = createH3DeviceConnections(() =>
    createH3HttpJsonRpcConnection(options.runtime),
  );
  const initialStoreState = await loadH3PairingStoreState(options.storeRootPath);
  let latestTrustedDevice: H3TrustedDeviceRecord | null =
    initialStoreState.trustedDevices[0] ?? null;

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
  const handleHealth = (): Response => {
    return jsonResponse({ ok: true, h3: options.enableH3 !== false });
  };

  const handleTicket = (req: Request): Response => {
    const unauthorized = requireAdminToken(req, adminToken);
    if (unauthorized) return unauthorized;
    if (!server) return textResponse("Not ready", { status: 503 });
    const port = server.port;
    if (port === undefined) return textResponse("Not ready", { status: 503 });
    return jsonResponse({ ticket: createTicket(port) });
  };

  const handlePair = async (req: Request): Promise<Response> => {
    const parsed = parsePairingRequestBody(await req.json().catch(() => null));
    if (parsed === null) {
      return jsonResponse({ error: "Invalid pairing request." }, { status: 400 });
    }
    const { rawTicket, nonce, deviceId, identityPub, displayName } = parsed;
    const decoded = decodePairingTicketForRequest(rawTicket);
    if (!decoded) {
      return jsonResponse({ error: "Invalid pairing request." }, { status: 400 });
    }
    if (pairingConsumed || decoded.nonce !== nonce || !verifyH3PairingNonce(pairing, nonce)) {
      return jsonResponse({ error: "Pairing session expired." }, { status: 401 });
    }
    const port = server?.port;
    if (port === undefined) return textResponse("Not ready", { status: 503 });
    if (!pairingTicketMatchesExpected(decoded, createTicket(port))) {
      return jsonResponse({ error: "Invalid pairing request." }, { status: 400 });
    }
    pairingConsumed = true;
    const sessionToken = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
    const trustedDevice = await rememberH3TrustedDevice(options.storeRootPath, {
      deviceId,
      identityPub,
      displayName,
      sessionToken,
    });
    deviceConnections.close(deviceId);
    latestTrustedDevice = trustedDevice;
    return jsonResponse({
      sessionToken,
      trustedDevice: {
        deviceId: trustedDevice.deviceId,
        fingerprint: trustedDevice.fingerprint,
        displayName: trustedDevice.displayName,
        lastPairedAt: trustedDevice.lastPairedAt,
        lastConnectedAt: trustedDevice.lastConnectedAt,
        permissions: trustedDevice.permissions,
      },
    });
  };

  const handleRpcOrEvents = async (req: Request, url: URL): Promise<Response | null> => {
    const sessionToken = parseBearerToken(req.headers.get("authorization"));
    const deviceIdHeader = req.headers.get(MOBILE_DEVICE_ID_HEADER);
    const isEventStream = req.method === "GET" && url.pathname === "/events";
    const trustedDevice = isEventStream
      ? await verifyH3SessionToken(options.storeRootPath, sessionToken, deviceIdHeader)
      : await findH3TrustedDeviceBySessionToken(
          options.storeRootPath,
          sessionToken,
          deviceIdHeader,
        );
    if (!trustedDevice) {
      return jsonResponse({ error: "Unauthorized." }, { status: 401 });
    }

    if (req.method === "POST" && url.pathname === "/rpc") {
      const raw = await req.json().catch(() => null);
      return await dispatchHttpRpcPayload(
        raw,
        deviceConnections.get(trustedDevice.deviceId),
        trustedDevice,
      );
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const connection = deviceConnections.get(trustedDevice.deviceId);
      applyTrustedDevicePermissionsToConnection(connection, trustedDevice);
      const streamOwner = Symbol(trustedDevice.deviceId);
      deviceConnections.setEventStreamOwner(trustedDevice.deviceId, streamOwner);
      let removeSink: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          removeSink = connection.addEventSink(controller);
        },
        cancel() {
          removeSink?.();
          if (deviceConnections.getEventStreamOwner(trustedDevice.deviceId) !== streamOwner) return;
          deviceConnections.clearEventStreamOwner(trustedDevice.deviceId);
          if (deviceConnections.current(trustedDevice.deviceId) !== connection) return;
          deviceConnections.close(trustedDevice.deviceId);
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
    return null;
  };

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return handleHealth();
    if (req.method === "GET" && url.pathname === "/ticket") return handleTicket(req);
    if (req.method === "POST" && url.pathname === "/pair") return await handlePair(req);
    if (url.pathname === "/rpc" || url.pathname === "/events") {
      const response = await handleRpcOrEvents(req, url);
      if (response) return response;
    }
    return textResponse("Not found", { status: 404 });
  };

  const serveOptions = {
    hostname,
    tls: {
      cert: certificate.certPem,
      key: certificate.keyPem,
    },
    ...(options.enableH3 === false ? {} : { h3: true }),
    fetch,
  };

  try {
    server = Bun.serve<StartServerSocketData>({
      ...serveOptions,
      port: preferredPort,
    });
  } catch (error) {
    if (preferredPort > 0 && options.runtime.isAddrInUse(error)) {
      server = Bun.serve<StartServerSocketData>({
        ...serveOptions,
        port: 0,
      });
    } else {
      throw error;
    }
  }

  const port = server.port;
  if (port === undefined) {
    await server.stop(true);
    throw new Error("H3 mobile server did not bind to a port.");
  }
  await persistH3ListenerPort(options.storeRootPath, port);
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
    trustedDevices: await summarizeTrustedDevices(options.storeRootPath),
    async listTrustedDevices() {
      return await summarizeTrustedDevices(options.storeRootPath);
    },
    async updateTrustedDevicePermissions(deviceId, permissions) {
      const allowedPatch: Partial<Record<H3TrustedDevicePermissionKey, boolean>> = {};
      for (const key of H3_TRUSTED_DEVICE_PERMISSION_KEYS) {
        if (typeof permissions[key] === "boolean") {
          allowedPatch[key] = permissions[key] === true;
        }
      }
      const updated = await updateH3TrustedDevicePermissions(
        options.storeRootPath,
        deviceId,
        allowedPatch,
      );
      if (updated && latestTrustedDevice?.deviceId === updated.deviceId) {
        latestTrustedDevice = updated;
      }
      if (
        updated &&
        (allowedPatch.conversations === false || allowedPatch.workspaceSettings === false)
      ) {
        deviceConnections.close(updated.deviceId);
      }
      return summarizeTrustedDevice(updated);
    },
    async revokeTrustedDevice(deviceId: string) {
      deviceConnections.close(deviceId);
      const removed = await forgetH3TrustedDevice(options.storeRootPath, deviceId);
      if (latestTrustedDevice?.deviceId === deviceId) {
        const state = await loadH3PairingStoreState(options.storeRootPath);
        latestTrustedDevice = state.trustedDevices[0] ?? null;
      }
      return removed;
    },
    async revokeTrustedDevices() {
      deviceConnections.closeAll();
      await forgetH3TrustedDevices(options.storeRootPath);
      latestTrustedDevice = null;
    },
    async stop() {
      deviceConnections.closeAll();
      await server.stop(true);
    },
  };
}

export const __internal = {
  createHttpJsonRpcConnection: createH3HttpJsonRpcConnection,
  DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS,
  decodePairingTicketForRequest,
  dispatchHttpRpcPayload,
  formatUrlHost,
  getRequiredH3Permission,
  requireAdminToken,
};
