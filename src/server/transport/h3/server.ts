import {
  type CoworkPairingTicket,
  coworkPairingTicketSchema,
  decodeCoworkPairingTicket,
  encodeCoworkPairingTicket,
} from "../../../shared/coworkTicket";
import type {
  JsonRpcLiteClientResponse,
  JsonRpcLiteNotification,
  JsonRpcLiteRequest,
} from "../../jsonrpc/protocol";
import { getTaskRpcRequiredPermissions } from "../../jsonrpc/taskPermissions";
import type { AgentServerRuntime } from "../../runtime/ServerRuntime";
import type { StartServerSocketData } from "../../startServer/types";
import {
  createH3PairingSession,
  DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS,
  forgetH3TrustedDevice,
  forgetH3TrustedDevices,
  H3_TRUSTED_DEVICE_PERMISSION_KEYS,
  type H3PairingSession,
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
import {
  loadOrCreatePersistedQuicCertificate,
  persistH3ListenerPort,
  resolvePersistedH3Port,
} from "./persistedListener";

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
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
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

function applyTrustedDevicePermissionsToConnection(
  connection: H3JsonRpcConnection,
  trustedDevice: H3TrustedDeviceRecord,
): void {
  connection.data.workspaceControlEventsAllowed =
    trustedDevice.permissions.workspaceSettings === true;
  connection.data.taskReadAllowed = trustedDevice.permissions.conversations === true;
  connection.data.taskMutationAllowed =
    trustedDevice.permissions.conversations === true && trustedDevice.permissions.turns === true;
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
  trustedDevice: H3TrustedDeviceRecord,
): Promise<Response> {
  applyTrustedDevicePermissionsToConnection(connection, trustedDevice);
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

  const requiredPermission = getRequiredH3Permission(message);
  const requiredPermissions =
    requiredPermission === null
      ? []
      : Array.isArray(requiredPermission)
        ? requiredPermission
        : [requiredPermission];
  const missingPermission = requiredPermissions.find(
    (permission) => trustedDevice.permissions[permission] !== true,
  );
  if (missingPermission) {
    return jsonResponse(
      {
        error: `Mobile device permission required: ${missingPermission}.`,
        permission: missingPermission,
      },
      { status: 403 },
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

const ALWAYS_ALLOWED_H3_RPC_METHODS = new Set([
  "initialize",
  "initialized",
  "thread/unsubscribe",
  "workspace/list",
  "workspace/switch",
  "cowork/session/harnessContext/get",
  "cowork/provider/catalog/read",
  "cowork/provider/authMethods/read",
  "cowork/provider/status/refresh",
  "cowork/provider/codexAppServer/status",
  "cowork/runtime/libreoffice/check",
  "cowork/agentProfiles/catalog/read",
  "cowork/skills/catalog/read",
  "cowork/skills/list",
  "cowork/skills/read",
  "cowork/skills/installation/read",
  "cowork/plugins/catalog/read",
  "cowork/plugins/read",
  "cowork/connectors/openai-native/list",
  "cowork/connectors/openai-native/refresh",
]);

function getRequiredH3Permission(
  message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
): H3TrustedDevicePermissionKey | H3TrustedDevicePermissionKey[] | null {
  if (!("method" in message)) {
    return "serverRequests";
  }
  const method = message.method;
  if (ALWAYS_ALLOWED_H3_RPC_METHODS.has(method)) {
    return null;
  }
  if (
    method === "thread/fork" ||
    method === "thread/pinned/set" ||
    method === "thread/archived/set"
  ) {
    return ["conversations", "turns"];
  }
  if (method === "thread/start" || method.startsWith("turn/")) {
    return "turns";
  }
  // Reading workspace control state (session/workspace config, provider options,
  // userName/userProfile) requires the workspace-settings permission. Bootstrap
  // returns that same state AND thread summaries, so it requires both the
  // workspace-settings and conversations permissions; neither may be added back
  // to ALWAYS_ALLOWED_H3_RPC_METHODS.
  if (method === "cowork/session/state/read") {
    return "workspaceSettings";
  }
  if (method === "cowork/workspace/bootstrap") {
    return ["workspaceSettings", "conversations"];
  }
  // Reading thread/conversation history (list, read, hydrate, and resume — which
  // streams a thread's live content) requires the dedicated `conversations`
  // permission. `thread/unsubscribe` only tears down a subscription (no content)
  // and stays always-allowed.
  if (
    method === "thread/list" ||
    method === "thread/read" ||
    method === "thread/hydrate" ||
    method === "thread/resume"
  ) {
    return "conversations";
  }
  if (method.startsWith("task/")) {
    const permissions = getTaskRpcRequiredPermissions(method);
    return permissions.length === 1 ? (permissions[0] ?? null) : permissions;
  }
  if (method.startsWith("cowork/provider/auth/")) {
    return "providerAuth";
  }
  if (method.startsWith("cowork/mcp/server/auth/")) {
    return "mcpAuth";
  }
  // The MCP server config surface requires the workspace-settings permission:
  // reads/upserts expose or mutate transport env/headers that hold downstream
  // secrets, and `cowork/mcp/server/validate` starts the configured stdio MCP
  // command (spawns a local subprocess) while connecting. Neither may be added
  // back to ALWAYS_ALLOWED_H3_RPC_METHODS — a freshly paired, default-permission
  // device would otherwise read MCP secrets or start configured local commands.
  if (method.startsWith("cowork/mcp/")) {
    return "workspaceSettings";
  }
  // Memory (basic + advanced, read and write) holds long-lived private user and
  // project content, so the whole `cowork/memory/*` surface requires the
  // workspace-settings permission. `cowork/memory/list` must never be added back
  // to ALWAYS_ALLOWED_H3_RPC_METHODS — a freshly paired, default-permission
  // device would otherwise read stored user/workspace memory content.
  if (method.startsWith("cowork/memory/")) {
    return "workspaceSettings";
  }
  // Plugin install/preview materializes an attacker-selectable local or GitHub
  // source (root traversal, manifest reads, bundled MCP config diagnostics)
  // before any install, so it requires the workspace-settings permission like the
  // rest of plugin management. Only the passive `cowork/plugins/catalog/read` and
  // `cowork/plugins/read` stay always-allowed; the preview must never be added
  // back to ALWAYS_ALLOWED_H3_RPC_METHODS.
  if (method === "cowork/plugins/install/preview") {
    return "workspaceSettings";
  }
  // Skill install/preview, like plugin install/preview, materializes an
  // attacker-selectable local or GitHub source (recursive SKILL.md discovery,
  // manifest/metadata reads) before any install, so it requires the
  // workspace-settings permission. Only the passive `cowork/skills/catalog/read`,
  // `cowork/skills/list`, `cowork/skills/read`, and `cowork/skills/installation/read`
  // reads stay always-allowed; the preview must never be added back to it.
  if (method === "cowork/skills/install/preview") {
    return "workspaceSettings";
  }
  // Workspace document operations that execute code or read arbitrary file
  // content require the workspace-settings permission:
  //   - `cowork/workspace/presentation/preview` imports and runs a workspace
  //     slide module (`slide-N.mjs`) on the host (code execution), and
  //   - `cowork/workspace/spreadsheet/*` reads bounded CSV/XLSX content from a
  //     caller-selected cwd that is NOT confined to the active workspace, so it
  //     can disclose any .csv/.xlsx readable by the desktop user.
  // Only `cowork/workspace/bootstrap` stays always-allowed; none of these may be
  // added back to ALWAYS_ALLOWED_H3_RPC_METHODS.
  if (
    method === "cowork/workspace/presentation/preview" ||
    method.startsWith("cowork/workspace/spreadsheet/")
  ) {
    return "workspaceSettings";
  }
  if (method.startsWith("cowork/backups/")) {
    return "backups";
  }
  return "workspaceSettings";
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
  expectedRaw: CoworkPairingTicket,
): boolean {
  const expected = coworkPairingTicketSchema.parse(expectedRaw);
  if (
    actual.v !== expected.v ||
    actual.scheme !== expected.scheme ||
    actual.port !== expected.port ||
    actual.certSha256 !== expected.certSha256 ||
    actual.spkiSha256 !== expected.spkiSha256 ||
    actual.identityPub !== expected.identityPub ||
    actual.nonce !== expected.nonce ||
    actual.expiresAt !== expected.expiresAt ||
    actual.hosts.length !== expected.hosts.length
  ) {
    return false;
  }
  return actual.hosts.every((host, index) => host === expected.hosts[index]);
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

function createHttpJsonRpcConnection(
  runtime: AgentServerRuntime,
  options?: { keepaliveIntervalMs?: number },
): H3JsonRpcConnection {
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

  const connection: H3Connection = {
    data: {
      connectionId: crypto.randomUUID(),
      protocolMode: "h3",
      selectedSubprotocol: "cowork.jsonrpc.v1",
      workspaceControlEventsAllowed: false,
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
  const certificate = await loadOrCreatePersistedQuicCertificate(options.storeRootPath, {
    forceRotate: options.rotateTls === true,
  });
  const preferredPort = await resolvePersistedH3Port(options.storeRootPath, options.port);
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
  const closeDeviceConnection = (deviceId: string): void => {
    const connection = httpConnections.get(deviceId);
    if (!connection) {
      return;
    }
    httpConnections.delete(deviceId);
    connection.close();
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
      if (!session || decoded.nonce !== nonce || !verifyH3PairingNonce(session, nonce)) {
        return jsonResponse({ error: "Pairing session expired." }, { status: 401 });
      }
      const port = server?.port;
      if (port === undefined) return textResponse("Not ready", { status: 503 });
      if (!pairingTicketMatchesExpected(decoded, createTicket(port))) {
        return jsonResponse({ error: "Invalid pairing request." }, { status: 400 });
      }
      pairingSessions.delete(nonce);
      const sessionToken = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
      const trustedDevice = await rememberH3TrustedDevice(options.storeRootPath, {
        deviceId,
        identityPub,
        displayName,
        sessionToken,
      });
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
    }

    if (url.pathname === "/rpc" || url.pathname === "/events") {
      const trustedDevice = await verifyH3SessionToken(
        options.storeRootPath,
        parseBearerToken(req.headers.get("authorization")),
        req.headers.get(MOBILE_DEVICE_ID_HEADER),
      );
      if (!trustedDevice) {
        return jsonResponse({ error: "Unauthorized." }, { status: 401 });
      }

      if (req.method === "POST" && url.pathname === "/rpc") {
        const raw = await req.json().catch(() => null);
        return await dispatchHttpRpcPayload(
          raw,
          getConnection(trustedDevice.deviceId),
          trustedDevice,
        );
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const connection = getConnection(trustedDevice.deviceId);
        applyTrustedDevicePermissionsToConnection(connection, trustedDevice);
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
        closeDeviceConnection(updated.deviceId);
      }
      return summarizeTrustedDevice(updated);
    },
    async revokeTrustedDevice(deviceId: string) {
      closeDeviceConnection(deviceId);
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
  SSE_KEEPALIVE_INTERVAL_MS,
  DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS,
  decodePairingTicketForRequest,
  dispatchHttpRpcPayload,
  formatUrlHost,
  getRequiredH3Permission,
  requireAdminToken,
};
