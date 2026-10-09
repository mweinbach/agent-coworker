import "reflect-metadata";

import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import * as x509 from "@peculiar/x509";

import { MobileRelayBridge } from "../apps/desktop/electron/services/mobileRelayBridge";
import {
  SecureTransportClient,
  __internal as transportInternal,
} from "../apps/mobile/src/features/relay/secureTransportClient";
import type { AgentServerRuntime } from "../src/server/runtime/ServerRuntime";
import { startH3MobileServer } from "../src/server/transport/h3/server";
import {
  connectOpenTunnelBridge,
  createOpenTunnelCsr,
  decodeOpenTunnelBinaryFrame,
  encodeOpenTunnelBinaryFrame,
  loadOrProvisionOpenTunnelIdentity,
} from "../src/server/transport/opentunnel/openTunnelRelay";
import { decodeCoworkPairingTicket, encodeCoworkPairingTicket } from "../src/shared/coworkTicket";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cowork-opentunnel-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function signCsrForTest(csrPem: string): Promise<{
  certificatePem: string;
  chainPem: string;
  expiry: number;
}> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  const algorithm = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  } as const;
  const caKeys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const now = new Date();
  const expiryDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=OpenTunnel Test CA",
    notBefore: now,
    notAfter: expiryDate,
    signingAlgorithm: algorithm,
    keys: caKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
  });
  const leafCert = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: csr.subject,
    issuer: caCert.subject,
    notBefore: now,
    notAfter: expiryDate,
    signingAlgorithm: algorithm,
    publicKey: csr.publicKey,
    signingKey: caKeys.privateKey,
    extensions: csr.extensions,
  });
  return {
    certificatePem: leafCert.toString("pem"),
    chainPem: caCert.toString("pem"),
    expiry: expiryDate.getTime(),
  };
}

function openTunnelIdentityPath(storeRoot: string): string {
  return path.join(storeRoot, "mobile-pairing", "opentunnel-identity.json");
}

function createReadyProvisioningFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let tunnelCount = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/api/tunnel")) {
      tunnelCount += 1;
      const id = `tun/${tunnelCount}`;
      return Response.json(
        {
          tunnel: { id, hostname: `${id}.opentunnel.xyz` },
          token: `tok_${tunnelCount}`,
        },
        { status: 201 },
      );
    }
    if (method === "POST" && url.endsWith("/certificate")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { csr: string };
      const signed = await signCsrForTest(body.csr);
      return Response.json({
        state: {
          type: "ready",
          certificate: signed.certificatePem,
          chain: signed.chainPem,
          expiry: signed.expiry,
        },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("OpenTunnel mobile relay", () => {
  test("creates a valid ECDSA P-256 PKCS#10 CSR with wildcard SANs", async () => {
    const { csrPem, privateKeyPem } = await createOpenTunnelCsr("t-abc123.opentunnel.xyz");
    expect(csrPem).toContain("-----BEGIN CERTIFICATE REQUEST-----");
    expect(privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");

    const parsedCsr = new x509.Pkcs10CertificateRequest(csrPem);
    expect(parsedCsr.subject).toContain("CN=t-abc123.opentunnel.xyz");
    expect(await parsedCsr.verify()).toBe(true);
  });

  test("binary frame codec round-trips big-endian connection IDs and payloads", () => {
    const payload = new TextEncoder().encode("raw-tls-record");
    const encoded = encodeOpenTunnelBinaryFrame(0x01020304, payload);
    expect(encoded.byteLength).toBe(4 + payload.byteLength);

    const decoded = decodeOpenTunnelBinaryFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.conn).toBe(0x01020304);
    expect(new TextDecoder().decode(decoded?.payload)).toBe("raw-tls-record");

    expect(decodeOpenTunnelBinaryFrame(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("provisions, persists, reuses, and rotates OpenTunnel tunnel identity", async () => {
    const storeRoot = await createTempRoot();
    const calls: string[] = [];
    let tunnelCount = 0;
    let pollCalls = 0;
    let latestSigned: { certificatePem: string; chainPem: string; expiry: number } | null = null;

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);

      if (method === "POST" && url.endsWith("/api/tunnel")) {
        tunnelCount += 1;
        const id = `tun_${tunnelCount}`;
        return Response.json(
          {
            tunnel: {
              id,
              hostname: `${id}.opentunnel.xyz`,
              state: { type: "pending" },
            },
            token: `tok_${tunnelCount}`,
          },
          { status: 201 },
        );
      }

      if (method === "POST" && url.endsWith("/certificate")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { csr: string };
        latestSigned = await signCsrForTest(body.csr);
        pollCalls = 0;
        return Response.json(
          {
            id: `tun_${tunnelCount}`,
            state: { type: "issuing" },
          },
          { status: 202 },
        );
      }

      if (method === "GET" && url.endsWith("/certificate")) {
        pollCalls += 1;
        if (pollCalls < 2 || !latestSigned) {
          return Response.json({
            id: `tun_${tunnelCount}`,
            state: { type: "challenge" },
          });
        }
        return Response.json({
          id: `tun_${tunnelCount}`,
          state: {
            type: "ready",
            certificate: latestSigned.certificatePem,
            chain: latestSigned.chainPem,
            expiry: latestSigned.expiry,
          },
        });
      }

      if (method === "DELETE" && url.includes("/api/tunnel/")) {
        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const first = await loadOrProvisionOpenTunnelIdentity({
      storeRootPath: storeRoot,
      apiUrl: "https://opentunnel.xyz",
      pollIntervalMs: 10,
      fetchImpl: mockFetch,
    });
    expect(first.tunnelId).toBe("tun_1");
    expect(first.hostname).toBe("tun_1.opentunnel.xyz");
    expect(first.certSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.spkiSha256).toHaveLength(43);

    const callsAfterFirst = calls.length;
    const reused = await loadOrProvisionOpenTunnelIdentity({
      storeRootPath: storeRoot,
      apiUrl: "https://opentunnel.xyz",
      pollIntervalMs: 10,
      fetchImpl: mockFetch,
    });
    expect(reused.tunnelId).toBe("tun_1");
    expect(reused.certSha256).toBe(first.certSha256);
    expect(calls.length).toBe(callsAfterFirst);

    const rotated = await loadOrProvisionOpenTunnelIdentity({
      storeRootPath: storeRoot,
      apiUrl: "https://opentunnel.xyz",
      forceRotate: true,
      pollIntervalMs: 10,
      fetchImpl: mockFetch,
    });
    expect(rotated.tunnelId).toBe("tun_2");
    expect(rotated.hostname).toBe("tun_2.opentunnel.xyz");
    expect(calls).toContain("DELETE https://opentunnel.xyz/api/tunnel/tun_1");
  });

  test("reuses a normalized API URL and refuses foreign or near-expiry identities", async () => {
    const storeRoot = await createTempRoot();
    const { fetchImpl, calls } = createReadyProvisioningFetch();
    const provision = (apiUrl: string) =>
      loadOrProvisionOpenTunnelIdentity({
        storeRootPath: storeRoot,
        apiUrl,
        fetchImpl,
      });

    const first = await provision("https://opentunnel.xyz");
    expect(first.tunnelId).toBe("tun/1");
    expect(first.token).toBe("tok_1");
    expect(calls).toContain("POST https://opentunnel.xyz/api/tunnel/tun%2F1/certificate");

    const callsAfterReuseCheck = calls.length;
    const reused = await provision("  https://opentunnel.xyz/  ");
    expect(reused.tunnelId).toBe("tun/1");
    expect(reused.token).toBe("tok_1");
    expect(calls.length).toBe(callsAfterReuseCheck);

    const identityPath = openTunnelIdentityPath(storeRoot);
    const persisted = JSON.parse(await readFile(identityPath, "utf8")) as { expiry: number };
    persisted.expiry = Date.now() + 60_000;
    await writeFile(identityPath, JSON.stringify(persisted));
    const renewed = await provision("https://opentunnel.xyz");
    expect(renewed.tunnelId).toBe("tun/2");
    expect(renewed.token).toBe("tok_2");

    const foreign = await provision("https://evil.example");
    expect(foreign.tunnelId).toBe("tun/3");
    expect(foreign.token).toBe("tok_3");
    expect(foreign.apiUrl).toBe("https://evil.example");
    expect(calls).toContain("POST https://evil.example/api/tunnel");
  });

  test("ignores malformed and incomplete persisted identities", async () => {
    const storeRoot = await createTempRoot();
    const identityPath = openTunnelIdentityPath(storeRoot);
    await mkdir(path.dirname(identityPath), { recursive: true });
    await writeFile(identityPath, "null");
    const { fetchImpl, calls } = createReadyProvisioningFetch();
    const fromNull = await loadOrProvisionOpenTunnelIdentity({
      storeRootPath: storeRoot,
      apiUrl: "https://opentunnel.xyz",
      fetchImpl,
    });
    expect(fromNull.tunnelId).toBe("tun/1");

    await writeFile(
      identityPath,
      JSON.stringify({ apiUrl: "https://opentunnel.xyz", id: "stale", token: "" }),
    );
    const callsBeforeIncomplete = calls.length;
    const fromIncomplete = await loadOrProvisionOpenTunnelIdentity({
      storeRootPath: storeRoot,
      apiUrl: "https://opentunnel.xyz",
      fetchImpl,
    });
    expect(fromIncomplete.tunnelId).toBe("tun/2");
    expect(fromIncomplete.token).toBe("tok_2");
    expect(calls.length).toBeGreaterThan(callsBeforeIncomplete);
  });

  test("does not persist an identity when tunnel creation or issuance fails", async () => {
    const storeRoot = await createTempRoot();
    const identityPath = openTunnelIdentityPath(storeRoot);
    const httpFailure: typeof fetch = (async () =>
      new Response("unavailable", { status: 503 })) as typeof fetch;
    await expect(
      loadOrProvisionOpenTunnelIdentity({
        storeRootPath: storeRoot,
        apiUrl: "https://opentunnel.xyz",
        fetchImpl: httpFailure,
      }),
    ).rejects.toThrow("OpenTunnel creation failed with HTTP 503.");

    const missingToken: typeof fetch = (async () =>
      Response.json(
        { tunnel: { id: "tun/1", hostname: "tun.example" } },
        { status: 201 },
      )) as typeof fetch;
    await expect(
      loadOrProvisionOpenTunnelIdentity({
        storeRootPath: storeRoot,
        apiUrl: "https://opentunnel.xyz",
        fetchImpl: missingToken,
      }),
    ).rejects.toThrow("OpenTunnel creation response was missing tunnel id, hostname, or token.");

    const failedIssuance: typeof fetch = (async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/api/tunnel")) {
        return Response.json(
          {
            tunnel: { id: "tun/1", hostname: "tun.example" },
            token: "tok_1",
          },
          { status: 201 },
        );
      }
      return Response.json({ state: { type: "failed", error: "caa denied" } });
    }) as typeof fetch;
    await expect(
      loadOrProvisionOpenTunnelIdentity({
        storeRootPath: storeRoot,
        apiUrl: "https://opentunnel.xyz",
        fetchImpl: failedIssuance,
      }),
    ).rejects.toThrow("OpenTunnel certificate issuance failed: caa denied.");

    const pollTimeout: typeof fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/api/tunnel")) {
        return Response.json(
          {
            tunnel: { id: "tun/1", hostname: "tun.example" },
            token: "tok_1",
          },
          { status: 201 },
        );
      }
      if (method === "POST" && url.endsWith("/certificate")) {
        return Response.json({ state: { type: "issuing" } }, { status: 202 });
      }
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    await expect(
      loadOrProvisionOpenTunnelIdentity({
        storeRootPath: storeRoot,
        apiUrl: "https://opentunnel.xyz",
        pollIntervalMs: 10,
        pollTimeoutMs: 30,
        fetchImpl: pollTimeout,
      }),
    ).rejects.toThrow("OpenTunnel certificate poll failed with HTTP 503.");

    const issuanceTimeout: typeof fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/api/tunnel")) {
        return Response.json(
          {
            tunnel: { id: "tun/1", hostname: "tun.example" },
            token: "tok_1",
          },
          { status: 201 },
        );
      }
      return Response.json({ state: { type: "issuing" } });
    }) as typeof fetch;
    await expect(
      loadOrProvisionOpenTunnelIdentity({
        storeRootPath: storeRoot,
        apiUrl: "https://opentunnel.xyz",
        pollIntervalMs: 10,
        pollTimeoutMs: 30,
        fetchImpl: issuanceTimeout,
      }),
    ).rejects.toThrow("Timed out waiting for OpenTunnel certificate issuance.");

    await expect(access(identityPath)).rejects.toThrow();
  });

  test("multiplexes raw TLS streams over the OpenTunnel WebSocket bridge to the local mobile server", async () => {
    const storeRoot = await createTempRoot();
    let signedCert: { certificatePem: string; chainPem: string; expiry: number } | null = null;
    let bridgeServerWs: {
      send(data: string | Uint8Array): void;
      close(): void;
    } | null = null;
    const incomingBridgeFrames = new Map<
      number,
      {
        chunks: Buffer[];
        onChunk?: () => void;
      }
    >();

    const relayServer = Bun.serve<{ tunnelId: string }>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/api/tunnel") {
          return Response.json(
            {
              tunnel: {
                id: "t-live",
                hostname: "t-live.opentunnel.xyz",
                state: { type: "pending" },
              },
              token: "bridge-token-123",
            },
            { status: 201 },
          );
        }
        if (req.method === "POST" && url.pathname === "/api/tunnel/t-live/certificate") {
          const body = (await req.json()) as { csr: string };
          signedCert = await signCsrForTest(body.csr);
          return Response.json({
            id: "t-live",
            state: {
              type: "ready",
              certificate: signedCert.certificatePem,
              chain: signedCert.chainPem,
              expiry: signedCert.expiry,
            },
          });
        }
        if (url.pathname === "/api/tunnel/t-live/connect") {
          const upgraded = srv.upgrade(req, {
            headers: {
              "Sec-WebSocket-Protocol": "opentunnel",
            },
            data: { tunnelId: "t-live" },
          });
          if (upgraded) return undefined;
          return new Response("Upgrade failed", { status: 400 });
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          bridgeServerWs = ws;
        },
        message(ws, message) {
          if (typeof message === "string") {
            const parsed = JSON.parse(message) as { type: string; time_sent?: number };
            if (parsed.type === "attach") {
              ws.send(
                JSON.stringify({
                  type: "attached",
                  session: "sess_1",
                  routes: ["@", "cowork"],
                  heartbeat_ms: 15_000,
                  idle_timeout_ms: 45_000,
                }),
              );
            } else if (parsed.type === "ping") {
              ws.send(JSON.stringify({ type: "pong", time_sent: parsed.time_sent ?? 0 }));
            }
            return;
          }
          const decoded = decodeOpenTunnelBinaryFrame(
            message instanceof Uint8Array ? message : new Uint8Array(message),
          );
          if (!decoded) return;
          let state = incomingBridgeFrames.get(decoded.conn);
          if (!state) {
            state = { chunks: [] };
            incomingBridgeFrames.set(decoded.conn, state);
          }
          state.chunks.push(Buffer.from(decoded.payload));
          state.onChunk?.();
        },
      },
    });

    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
      closeConnection() {},
    } as unknown as AgentServerRuntime;

    const mobileServer = await startH3MobileServer({
      runtime,
      hostname: "127.0.0.1",
      hostHints: ["192.168.1.50"],
      storeRootPath: storeRoot,
      openTunnel: {
        enabled: true,
        required: true,
        apiUrl: `http://127.0.0.1:${relayServer.port}`,
      },
    });

    try {
      expect(mobileServer.url).toBe("https://t-live.opentunnel.xyz:443");
      expect(mobileServer.port).toBe(443);
      expect(mobileServer.hostHints[0]).toBe("t-live.opentunnel.xyz");
      expect(mobileServer.hostHints[1]).toBe(`192.168.1.50:${mobileServer.server.port}`);
      expect(bridgeServerWs).not.toBeNull();

      // Open a local TCP proxy that feeds raw TLS bytes through the OpenTunnel WebSocket bridge
      let clientProxyServer: net.Server | null = null;
      const proxyReady = new Promise<number>((resolve) => {
        const proxy = net.createServer((clientSocket) => {
          const connId = 42;
          incomingBridgeFrames.set(connId, {
            chunks: [],
            onChunk() {
              const entry = incomingBridgeFrames.get(connId);
              if (!entry) return;
              for (const chunk of entry.chunks.splice(0)) {
                clientSocket.write(chunk);
              }
            },
          });
          bridgeServerWs?.send(
            JSON.stringify({
              type: "open",
              conn: connId,
              peer: "203.0.113.10:55111",
              sni: "t-live.opentunnel.xyz",
              alpn: "http/1.1",
            }),
          );
          clientSocket.on("data", (chunk: Buffer) => {
            bridgeServerWs?.send(
              encodeOpenTunnelBinaryFrame(
                connId,
                new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
              ),
            );
          });
          clientSocket.on("end", () => {
            bridgeServerWs?.send(JSON.stringify({ type: "end", conn: connId }));
          });
        });
        proxy.listen(0, "127.0.0.1", () => {
          const addr = proxy.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
        clientProxyServer = proxy;
      });
      const proxyPort = await proxyReady;

      try {
        // Perform a real TLS handshake + HTTP GET /health through the multiplexed OpenTunnel bridge!
        const healthBody = await new Promise<string>((resolve, reject) => {
          const tlsSocket = tls.connect(
            {
              host: "127.0.0.1",
              port: proxyPort,
              servername: "t-live.opentunnel.xyz",
              rejectUnauthorized: false,
            },
            () => {
              tlsSocket.write(
                "GET /health HTTP/1.1\r\nHost: t-live.opentunnel.xyz\r\nConnection: close\r\n\r\n",
              );
            },
          );
          let responseData = "";
          tlsSocket.setEncoding("utf8");
          tlsSocket.on("data", (chunk) => {
            responseData += chunk;
          });
          tlsSocket.on("end", () => resolve(responseData));
          tlsSocket.on("error", reject);
        });

        expect(healthBody).toContain("HTTP/1.1 200");
        expect(healthBody).toContain('"openTunnel":true');
      } finally {
        clientProxyServer?.close();
      }
    } finally {
      await mobileServer.stop();
      await relayServer.stop(true);
    }
  });

  test("MobileRelayBridge and SecureTransportClient support OpenTunnel tickets and LAN host:port fallbacks", async () => {
    const ticket = encodeCoworkPairingTicket({
      v: 1,
      scheme: "opentunnel",
      hosts: ["t-live.opentunnel.xyz", "192.168.1.50:54443"],
      port: 443,
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
      identityPub: "desktop-id",
      nonce: "nonce-value-123456789012",
      expiresAt: Date.now() + 60_000,
    });
    const decoded = decodeCoworkPairingTicket(ticket);
    expect(decoded.scheme).toBe("opentunnel");

    const bridge = new MobileRelayBridge({
      serverManager: {
        startWorkspaceServer: async () => ({
          url: "ws://127.0.0.1:7337/ws",
          mobileH3: {
            url: "https://t-live.opentunnel.xyz:443",
            port: 443,
            hostHints: ["t-live.opentunnel.xyz", "192.168.1.50:54443"],
            ticket,
            adminToken: "admin",
            certSha256: "a".repeat(64),
            spkiSha256: "b".repeat(43),
            identityPub: "desktop-id",
            nonce: "nonce-value-123456789012",
            expiresAt: Date.now() + 60_000,
            trustedDevice: null,
            trustedDevices: [],
          },
        }),
        restartWorkspaceServer: async () => ({ url: "ws://127.0.0.1:7337/ws", mobileH3: null }),
        listMobileH3TrustedDevices: async () => [],
        revokeMobileH3TrustedDevice: async () => {},
        revokeMobileH3TrustedDevices: async () => {},
        updateMobileH3TrustedDevicePermissions: async () => ({}) as never,
      } as never,
    });

    const snapshot = await bridge.start({
      workspaceId: "ws_1",
      workspacePath: "/workspace",
      yolo: false,
    });
    expect(snapshot.relaySource).toBe("opentunnel");
    expect(snapshot.relayUrl).toBe("https://t-live.opentunnel.xyz:443");

    const store = new Map<string, string>();
    transportInternal.setSecureStoreForTesting({
      getItemAsync: async (k) => store.get(k) ?? null,
      setItemAsync: async (k, v) => {
        store.set(k, v);
      },
      deleteItemAsync: async (k) => {
        store.delete(k);
      },
    });
    const triedUrls: string[] = [];
    transportInternal.setPinnedHttpsFetchForTesting(async (req) => {
      triedUrls.push(req.url);
      if (req.url.startsWith("https://t-live.opentunnel.xyz:443")) {
        throw new Error("relay unreachable");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessionToken: "tok_123" }),
        text: async () => '{"sessionToken":"tok_123"}',
      };
    });
    transportInternal.setPinnedHttpsStreamForTesting(async () => () => {});

    try {
      const client = new SecureTransportClient();
      const connected = await client.connectFromQrPayload({
        ...decoded,
        rawTicket: ticket,
      });
      expect(connected.relayUrl).toBe("https://192.168.1.50:54443");
      expect(triedUrls.slice(0, 2)).toEqual([
        "https://t-live.opentunnel.xyz:443/pair",
        "https://192.168.1.50:54443/pair",
      ]);
      await client.disconnect();
    } finally {
      transportInternal.setSecureStoreForTesting(null);
      transportInternal.setPinnedHttpsFetchForTesting(null);
      transportInternal.setPinnedHttpsStreamForTesting(null);
    }
  });
});
