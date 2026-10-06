import "reflect-metadata";

import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import * as x509 from "@peculiar/x509";

import {
  type EphemeralQuicCertificate,
  fingerprintX509Certificate,
} from "../../../shared/quicCert";
import { resolveH3PairingStoreDir } from "../h3/pairing";

export const DEFAULT_OPENTUNNEL_API_URL = "https://opentunnel.xyz";
const OPENTUNNEL_IDENTITY_FILE_NAME = "opentunnel-identity.json";
const CERT_RENEWAL_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_CERT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_CERT_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const PEM_LINE_BREAK = "\n";

export type PersistedOpenTunnelIdentity = {
  version: 1;
  apiUrl: string;
  id: string;
  hostname: string;
  token: string;
  privateKeyPem: string;
  certificatePem: string;
  chainPem: string;
  expiry: number;
};

export type OpenTunnelCertificateBundle = EphemeralQuicCertificate & {
  tunnelId: string;
  hostname: string;
  token: string;
  apiUrl: string;
};

export type OpenTunnelProvisionOptions = {
  storeRootPath?: string;
  apiUrl?: string;
  tunnelName?: string;
  forceRotate?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type OpenTunnelBridgeOptions = {
  apiUrl?: string;
  tunnelId: string;
  token: string;
  localHost?: string;
  localPort: number;
  attachTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  webSocketFactory?: (url: string, protocols?: string | string[]) => WebSocket;
};

export type OpenTunnelBridgeHandle = {
  readonly session: string;
  readonly routes: string[];
  stop(): Promise<void>;
};

type TunnelCreateResponse = {
  tunnel?: {
    id?: string;
    hostname?: string;
    state?: unknown;
  };
  token?: string;
};

type CertificateStatusState =
  | {
      type: "ready";
      certificate: string;
      chain?: string;
      expiry: number;
    }
  | {
      type: "issuing" | "challenge";
    }
  | {
      type: "failed";
      error?: string;
    };

type CertificateStatusResponse = {
  id?: string;
  state?: CertificateStatusState;
};

type BridgeControlMessage =
  | {
      type: "attached";
      session: string;
      routes: string[];
      heartbeat_ms?: number;
      idle_timeout_ms?: number;
    }
  | {
      type: "attach_error";
      code?: string;
      message?: string;
    }
  | {
      type: "open";
      conn: number;
      peer?: string;
      sni?: string;
      alpn?: string;
    }
  | {
      type: "end";
      conn: number;
    }
  | {
      type: "reset";
      conn: number;
      code?: string;
    }
  | {
      type: "ping";
      time_sent: number;
    }
  | {
      type: "pong";
      time_sent: number;
    }
  | {
      type: "drain";
      reason?: string;
    };

function pemEncode(label: string, der: ArrayBuffer): string {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`, ""].join(PEM_LINE_BREAK);
}

function normalizeApiUrl(apiUrl?: string): string {
  const raw =
    apiUrl?.trim() ||
    process.env.COWORK_OPENTUNNEL_URL?.trim() ||
    process.env.OPENTUNNEL_API_URL?.trim() ||
    DEFAULT_OPENTUNNEL_API_URL;
  return raw.replace(/\/+$/, "");
}

function toWebSocketBaseUrl(apiUrl: string): string {
  if (apiUrl.startsWith("https://")) {
    return `wss://${apiUrl.slice("https://".length)}`;
  }
  if (apiUrl.startsWith("http://")) {
    return `ws://${apiUrl.slice("http://".length)}`;
  }
  return apiUrl;
}

function resolveOpenTunnelIdentityPath(storeRootPath: string | undefined): string {
  return path.join(resolveH3PairingStoreDir(storeRootPath), OPENTUNNEL_IDENTITY_FILE_NAME);
}

function isIdentityUsable(
  identity: PersistedOpenTunnelIdentity,
  expectedApiUrl: string,
  now = Date.now(),
): boolean {
  if (
    identity.version !== 1 ||
    identity.apiUrl !== expectedApiUrl ||
    !identity.id ||
    !identity.hostname ||
    !identity.token ||
    !identity.privateKeyPem ||
    !identity.certificatePem
  ) {
    return false;
  }
  return Number.isFinite(identity.expiry) && identity.expiry - now > CERT_RENEWAL_BUFFER_MS;
}

function bundleFromIdentity(identity: PersistedOpenTunnelIdentity): OpenTunnelCertificateBundle {
  const leafCert = new x509.X509Certificate(identity.certificatePem);
  const fullChainPem = identity.chainPem.trim()
    ? `${identity.certificatePem.trim()}\n${identity.chainPem.trim()}\n`
    : `${identity.certificatePem.trim()}\n`;
  return {
    tunnelId: identity.id,
    hostname: identity.hostname,
    token: identity.token,
    apiUrl: identity.apiUrl,
    certPem: fullChainPem,
    keyPem: identity.privateKeyPem,
    ...fingerprintX509Certificate(leafCert),
    notBefore: leafCert.notBefore.toISOString(),
    notAfter: leafCert.notAfter.toISOString(),
  };
}

async function readPersistedOpenTunnelIdentity(
  storeRootPath: string | undefined,
  expectedApiUrl: string,
): Promise<OpenTunnelCertificateBundle | null> {
  try {
    const raw = await fs.readFile(resolveOpenTunnelIdentityPath(storeRootPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedOpenTunnelIdentity> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const identity: PersistedOpenTunnelIdentity = {
      version: 1,
      apiUrl: typeof parsed.apiUrl === "string" ? parsed.apiUrl : "",
      id: typeof parsed.id === "string" ? parsed.id : "",
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
      privateKeyPem: typeof parsed.privateKeyPem === "string" ? parsed.privateKeyPem : "",
      certificatePem: typeof parsed.certificatePem === "string" ? parsed.certificatePem : "",
      chainPem: typeof parsed.chainPem === "string" ? parsed.chainPem : "",
      expiry: typeof parsed.expiry === "number" ? parsed.expiry : 0,
    };
    if (!isIdentityUsable(identity, expectedApiUrl)) {
      return null;
    }
    return bundleFromIdentity(identity);
  } catch {
    return null;
  }
}

async function writePersistedOpenTunnelIdentity(
  storeRootPath: string | undefined,
  identity: PersistedOpenTunnelIdentity,
): Promise<void> {
  const filePath = resolveOpenTunnelIdentityPath(storeRootPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(identity, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearPersistedOpenTunnelIdentity(
  storeRootPath: string | undefined,
  options?: { apiUrl?: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const filePath = resolveOpenTunnelIdentityPath(storeRootPath);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedOpenTunnelIdentity> | null;
    if (parsed?.id && parsed.token) {
      const apiUrl = normalizeApiUrl(options?.apiUrl ?? parsed.apiUrl);
      const fetchFn = options?.fetchImpl ?? fetch;
      await fetchFn(`${apiUrl}/api/tunnel/${encodeURIComponent(parsed.id)}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${parsed.token}`,
        },
      }).catch(() => undefined);
    }
  } catch {
    // Ignore missing or unreadable identity file.
  }
  await fs.unlink(filePath).catch(() => undefined);
}

export async function createOpenTunnelCsr(hostname: string): Promise<{
  csrPem: string;
  privateKeyPem: string;
}> {
  const algorithm = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  } as const;
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${hostname}`,
    keys,
    signingAlgorithm: algorithm,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: hostname },
        { type: "dns", value: `*.${hostname}` },
      ]),
    ],
  });
  const privateKeyDer = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    csrPem: csr.toString("pem"),
    privateKeyPem: pemEncode("PRIVATE KEY", privateKeyDer),
  };
}

export async function loadOrProvisionOpenTunnelIdentity(
  options: OpenTunnelProvisionOptions = {},
): Promise<OpenTunnelCertificateBundle> {
  const apiUrl = normalizeApiUrl(options.apiUrl);
  const fetchFn = options.fetchImpl ?? fetch;

  if (options.forceRotate) {
    await clearPersistedOpenTunnelIdentity(options.storeRootPath, {
      apiUrl,
      fetchImpl: fetchFn,
    });
  } else {
    const existing = await readPersistedOpenTunnelIdentity(options.storeRootPath, apiUrl);
    if (existing) {
      return existing;
    }
  }

  const createResponse = await fetchFn(`${apiUrl}/api/tunnel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: options.tunnelName ?? "cowork",
    }),
  });
  if (!createResponse.ok) {
    throw new Error(`OpenTunnel creation failed with HTTP ${createResponse.status}.`);
  }
  const created = (await createResponse.json()) as TunnelCreateResponse;
  const tunnelId = created.tunnel?.id?.trim() ?? "";
  const hostname = created.tunnel?.hostname?.trim() ?? "";
  const token = created.token?.trim() ?? "";
  if (!tunnelId || !hostname || !token) {
    throw new Error("OpenTunnel creation response was missing tunnel id, hostname, or token.");
  }

  const { csrPem, privateKeyPem } = await createOpenTunnelCsr(hostname);
  const bindResponse = await fetchFn(
    `${apiUrl}/api/tunnel/${encodeURIComponent(tunnelId)}/certificate`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ csr: csrPem }),
    },
  );
  if (!bindResponse.ok) {
    throw new Error(`OpenTunnel certificate binding failed with HTTP ${bindResponse.status}.`);
  }

  let certStatus = (await bindResponse.json().catch(() => ({}))) as CertificateStatusResponse;
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_CERT_POLL_INTERVAL_MS);
  const pollTimeoutMs = Math.max(
    pollIntervalMs,
    options.pollTimeoutMs ?? DEFAULT_CERT_POLL_TIMEOUT_MS,
  );
  const deadline = Date.now() + pollTimeoutMs;

  while (certStatus.state?.type !== "ready") {
    if (certStatus.state?.type === "failed") {
      throw new Error(
        `OpenTunnel certificate issuance failed: ${certStatus.state.error ?? "unknown error"}.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for OpenTunnel certificate issuance.");
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const pollResponse = await fetchFn(
      `${apiUrl}/api/tunnel/${encodeURIComponent(tunnelId)}/certificate`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    if (!pollResponse.ok) {
      throw new Error(`OpenTunnel certificate poll failed with HTTP ${pollResponse.status}.`);
    }
    certStatus = (await pollResponse.json()) as CertificateStatusResponse;
  }

  const readyState = certStatus.state;
  const identity: PersistedOpenTunnelIdentity = {
    version: 1,
    apiUrl,
    id: tunnelId,
    hostname,
    token,
    privateKeyPem,
    certificatePem: readyState.certificate,
    chainPem: readyState.chain ?? "",
    expiry: readyState.expiry,
  };
  await writePersistedOpenTunnelIdentity(options.storeRootPath, identity);
  return bundleFromIdentity(identity);
}

export function encodeOpenTunnelBinaryFrame(
  conn: number,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(new ArrayBuffer(4 + payload.byteLength));
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(0, conn >>> 0, false);
  frame.set(payload, 4);
  return frame;
}

export function decodeOpenTunnelBinaryFrame(
  raw: ArrayBuffer | Uint8Array,
): { conn: number; payload: Uint8Array } | null {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < 4) {
    return null;
  }
  const conn = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  return {
    conn,
    payload: bytes.subarray(4),
  };
}

type MultiplexedTcpEntry = {
  socket: net.Socket;
  connected: boolean;
  pendingWrites: Uint8Array[];
  endRequested: boolean;
};

export async function connectOpenTunnelBridge(
  options: OpenTunnelBridgeOptions,
): Promise<OpenTunnelBridgeHandle> {
  const apiUrl = normalizeApiUrl(options.apiUrl);
  const wsUrl = `${toWebSocketBaseUrl(apiUrl)}/api/tunnel/${encodeURIComponent(options.tunnelId)}/connect`;
  const localHost = options.localHost ?? "127.0.0.1";
  const localPort = options.localPort;
  const attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
  const reconnectBaseDelayMs = Math.max(50, options.reconnectBaseDelayMs ?? 1_000);
  const reconnectMaxDelayMs = Math.max(reconnectBaseDelayMs, options.reconnectMaxDelayMs ?? 30_000);
  const createWebSocket =
    options.webSocketFactory ??
    ((url: string, protocols?: string | string[]) => new WebSocket(url, protocols));

  let stopped = false;
  let currentWs: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let currentSession = "";
  let currentRoutes: string[] = [];
  const activeConns = new Map<number, MultiplexedTcpEntry>();

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const closeAllTcpConnections = () => {
    for (const [, entry] of activeConns) {
      entry.socket.destroy();
    }
    activeConns.clear();
  };

  const sendJson = (ws: WebSocket, payload: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const sendBinary = (ws: WebSocket, conn: number, payload: Uint8Array) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeOpenTunnelBinaryFrame(conn, payload));
    }
  };

  const handleOpenConn = (ws: WebSocket, conn: number) => {
    const existing = activeConns.get(conn);
    if (existing) {
      existing.socket.destroy();
      activeConns.delete(conn);
    }

    const socket = net.connect({ host: localHost, port: localPort });
    const entry: MultiplexedTcpEntry = {
      socket,
      connected: false,
      pendingWrites: [],
      endRequested: false,
    };
    activeConns.set(conn, entry);

    socket.on("connect", () => {
      if (activeConns.get(conn) !== entry) return;
      entry.connected = true;
      for (const chunk of entry.pendingWrites.splice(0)) {
        socket.write(chunk);
      }
      if (entry.endRequested) {
        socket.end();
      }
    });

    socket.on("data", (chunk: Buffer) => {
      if (activeConns.get(conn) !== entry) return;
      sendBinary(ws, conn, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });

    socket.on("end", () => {
      if (activeConns.get(conn) !== entry) return;
      sendJson(ws, { type: "end", conn });
    });

    socket.on("error", () => {
      if (activeConns.get(conn) !== entry) return;
      activeConns.delete(conn);
      sendJson(ws, { type: "reset", conn, code: "upstream_error" });
    });

    socket.on("close", () => {
      if (activeConns.get(conn) === entry) {
        activeConns.delete(conn);
      }
    });
  };

  const handleBinaryFrame = (raw: ArrayBuffer | Uint8Array) => {
    const decoded = decodeOpenTunnelBinaryFrame(raw);
    if (!decoded) return;
    const entry = activeConns.get(decoded.conn);
    if (!entry) return;
    if (entry.connected) {
      entry.socket.write(decoded.payload);
    } else {
      entry.pendingWrites.push(new Uint8Array(decoded.payload));
    }
  };

  const openAndAttachOnce = (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = createWebSocket(wsUrl, "opentunnel");
      ws.binaryType = "arraybuffer";
      currentWs = ws;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Ignore close errors on timed-out socket.
        }
        reject(new Error("Timed out attaching to OpenTunnel bridge."));
      }, attachTimeoutMs);
      (timeout as { unref?: () => void }).unref?.();

      const failAttach = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      ws.addEventListener("open", () => {
        sendJson(ws, {
          type: "attach",
          token: options.token,
          transport: "ws",
          routes: ["@", "cowork"],
          client: {
            version: "0.1.0",
            max_conns: 256,
          },
        });
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") {
          if (event.data instanceof ArrayBuffer) {
            handleBinaryFrame(event.data);
          } else if (ArrayBuffer.isView(event.data)) {
            handleBinaryFrame(
              new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
            );
          }
          return;
        }

        let control: BridgeControlMessage | null = null;
        try {
          control = JSON.parse(event.data) as BridgeControlMessage;
        } catch {
          return;
        }
        if (!control || typeof control !== "object") return;

        switch (control.type) {
          case "attached": {
            currentSession = control.session;
            currentRoutes = Array.isArray(control.routes) ? control.routes : [];
            reconnectAttempt = 0;
            clearHeartbeat();
            const intervalMs = Math.max(1_000, control.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS);
            heartbeatTimer = setInterval(() => {
              sendJson(ws, { type: "ping", time_sent: Date.now() });
            }, intervalMs);
            (heartbeatTimer as { unref?: () => void }).unref?.();
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
            break;
          }
          case "attach_error": {
            failAttach(
              new Error(
                `OpenTunnel attach failed: ${control.code ?? control.message ?? "rejected"}.`,
              ),
            );
            try {
              ws.close();
            } catch {
              // Ignore close error after attach rejection.
            }
            break;
          }
          case "open": {
            handleOpenConn(ws, control.conn);
            break;
          }
          case "end": {
            const entry = activeConns.get(control.conn);
            if (entry) {
              if (entry.connected) {
                entry.socket.end();
              } else {
                entry.endRequested = true;
              }
            }
            break;
          }
          case "reset": {
            const entry = activeConns.get(control.conn);
            if (entry) {
              activeConns.delete(control.conn);
              entry.socket.destroy();
            }
            break;
          }
          case "ping": {
            sendJson(ws, { type: "pong", time_sent: control.time_sent });
            break;
          }
          case "pong":
          case "drain":
            break;
        }
      });

      ws.addEventListener("error", () => {
        if (!settled) {
          failAttach(new Error("OpenTunnel WebSocket connection error."));
        }
      });

      ws.addEventListener("close", () => {
        clearHeartbeat();
        closeAllTcpConnections();
        if (!settled) {
          failAttach(new Error("OpenTunnel WebSocket closed before attach completed."));
          return;
        }
        if (stopped || currentWs !== ws) {
          return;
        }
        const attempt = ++reconnectAttempt;
        const delayMs = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** (attempt - 1));
        clearReconnect();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (stopped) return;
          void openAndAttachOnce().catch(() => undefined);
        }, delayMs);
        (reconnectTimer as { unref?: () => void }).unref?.();
      });
    });
  };

  await openAndAttachOnce();

  return {
    get session() {
      return currentSession;
    },
    get routes() {
      return [...currentRoutes];
    },
    async stop() {
      stopped = true;
      clearReconnect();
      clearHeartbeat();
      closeAllTcpConnections();
      const ws = currentWs;
      currentWs = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch {
          // Ignore close errors on timed-out socket.
        }
      }
    },
  };
}
