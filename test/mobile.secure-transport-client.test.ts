import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PairingQrPayload } from "../apps/mobile/src/features/pairing/pairingTypes";

const secureStoreValues = new Map<string, string>();

const secureStore = {
  getItemAsync: mock(async (key: string) => secureStoreValues.get(key) ?? null),
  setItemAsync: mock(async (key: string, value: string) => {
    secureStoreValues.set(key, value);
  }),
  deleteItemAsync: mock(async (key: string) => {
    secureStoreValues.delete(key);
  }),
};

const { __internal, SecureTransportClient } = await import(
  "../apps/mobile/src/features/relay/secureTransportClient"
);

function buildPayload(overrides?: Partial<PairingQrPayload>): PairingQrPayload {
  return {
    v: 1,
    scheme: "h3",
    hosts: ["unreachable.local", "192.168.1.10"],
    port: 9443,
    certSha256: "a".repeat(64),
    spkiSha256: "b".repeat(43),
    identityPub: "desktop-identity",
    nonce: "pairing-nonce",
    expiresAt: Date.now() + 60_000,
    rawTicket: "cowork-pair://ticket",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
}

describe("mobile secure transport client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    secureStoreValues.clear();
    __internal.setSecureStoreForTesting(secureStore);
    __internal.setPinnedHttpsFetchForTesting(null);
    __internal.setPinnedHttpsStreamForTesting(null);
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    __internal.setSecureStoreForTesting(null);
    __internal.setPinnedHttpsFetchForTesting(null);
    __internal.setPinnedHttpsStreamForTesting(null);
    globalThis.fetch = originalFetch;
  });

  test("tries later advertised hosts when the first pairing endpoint is unreachable", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = mock(async (request: { url: string }) => {
      requestedUrls.push(request.url);
      if (request.url.startsWith("https://unreachable.local:9443")) {
        throw new Error("network unreachable");
      }
      if (request.url === "https://192.168.1.10:9443/pair") {
        return Response.json({ sessionToken: "session-token" }) as unknown as Response;
      }
      return new Response("", { status: 200 });
    });
    __internal.setPinnedHttpsFetchForTesting(fetchMock as never);

    const client = new SecureTransportClient();
    const snapshot = await client.connectFromQrPayload(buildPayload());
    await waitFor(() => requestedUrls.some((url) => url.endsWith("/events")));

    expect(snapshot.status).toBe("connected");
    expect(snapshot.relayUrl).toBe("https://192.168.1.10:9443");
    expect(requestedUrls).toEqual([
      "https://unreachable.local:9443/pair",
      "https://192.168.1.10:9443/pair",
      "https://192.168.1.10:9443/events",
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toMatchObject({
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
    });
    expect(fetchMock.mock.calls[2]?.[0]).toMatchObject({
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
    });
  });

  test("brackets IPv6 literal hosts when building pairing endpoint URLs", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = mock(async (request: { url: string }) => {
      requestedUrls.push(request.url);
      if (request.url === "https://[2001:db8::1]:9443/pair") {
        return Response.json({ sessionToken: "session-token" }) as unknown as Response;
      }
      return new Response("", { status: 200 });
    });
    __internal.setPinnedHttpsFetchForTesting(fetchMock as never);

    const client = new SecureTransportClient();
    const snapshot = await client.connectFromQrPayload(buildPayload({ hosts: ["2001:db8::1"] }));
    await waitFor(() => requestedUrls.some((url) => url.endsWith("/events")));

    expect(snapshot.status).toBe("connected");
    expect(snapshot.relayUrl).toBe("https://[2001:db8::1]:9443");
    expect(requestedUrls).toEqual([
      "https://[2001:db8::1]:9443/pair",
      "https://[2001:db8::1]:9443/events",
    ]);
  });

  test("uses pinned HTTPS for RPC messages after pairing", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const plaintextMessages: string[] = [];
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string; method: string; body?: string }) => {
        requests.push(request);
        if (request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        if (request.url.endsWith("/events")) {
          return await new Promise<Response>(() => {});
        }
        if (request.url.endsWith("/rpc")) {
          return new Response("server-response", { status: 200 });
        }
        return new Response("", { status: 404 });
      }) as never,
    );
    const client = new SecureTransportClient();
    client.subscribe({
      onPlaintextMessage: (text) => plaintextMessages.push(text),
    });

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await client.sendPlaintext('{"jsonrpc":"2.0","method":"thread/list","id":1}');

    expect(requests.find((request) => request.url.endsWith("/rpc"))).toMatchObject({
      url: "https://192.168.1.10:9443/rpc",
      method: "POST",
      body: '{"jsonrpc":"2.0","method":"thread/list","id":1}',
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
    });
    expect(plaintextMessages).toEqual(["server-response"]);
  });

  test("reuses a stable mobile device id across QR pairing attempts", async () => {
    const pairedDeviceIds: string[] = [];
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string; body?: string }) => {
        if (request.url.endsWith("/pair")) {
          pairedDeviceIds.push(JSON.parse(request.body ?? "{}").deviceId);
          return Response.json({ sessionToken: `session-${pairedDeviceIds.length}` }) as never;
        }
        return new Response("", { status: 404 }) as never;
      }) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(mock(async () => () => {}));

    const client = new SecureTransportClient();
    await client.connectFromQrPayload(buildPayload({ nonce: "pairing-nonce-1" }));
    await client.connectFromQrPayload(buildPayload({ nonce: "pairing-nonce-2" }));

    expect(pairedDeviceIds).toHaveLength(2);
    expect(pairedDeviceIds[0]).toBe(pairedDeviceIds[1]);
    expect(secureStoreValues.get("cowork.h3.mobileDeviceId.v1")).toBe(pairedDeviceIds[0]);
  });

  test("delivers SSE messages as native pinned stream chunks arrive", async () => {
    const plaintextMessages: string[] = [];
    let streamHandlers:
      | Parameters<NonNullable<Parameters<typeof __internal.setPinnedHttpsStreamForTesting>[0]>>[1]
      | null = null;
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        return new Response("", { status: 404 });
      }) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async (_request, handlers) => {
        streamHandlers = handlers;
        return () => {};
      }),
    );

    const client = new SecureTransportClient();
    client.subscribe({
      onPlaintextMessage: (text) => plaintextMessages.push(text),
    });

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => streamHandlers !== null);
    expect(plaintextMessages).toEqual([]);

    streamHandlers?.onChunk("data: first");
    expect(plaintextMessages).toEqual([]);

    streamHandlers?.onChunk("\n\ndata: second\n");
    expect(plaintextMessages).toEqual(["first"]);

    streamHandlers?.onChunk("data: line\n\n");
    expect(plaintextMessages).toEqual(["first", "second\nline"]);
  });

  test("reopens the event stream when restoring a persisted active session snapshot", async () => {
    const streamUrls: string[] = [];
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        return new Response("", { status: 404 });
      }) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async (request) => {
        streamUrls.push(request.url);
        return () => {};
      }),
    );

    const client = new SecureTransportClient();
    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    expect(streamUrls).toEqual(["https://192.168.1.10:9443/events"]);

    const restoredClient = new SecureTransportClient();
    const restoredSnapshot = await restoredClient.getSnapshot();

    expect(restoredSnapshot).toMatchObject({
      status: "connected",
      connectedMacDeviceId: "desktop-identity",
      relayUrl: "https://192.168.1.10:9443",
    });
    expect(streamUrls).toEqual([
      "https://192.168.1.10:9443/events",
      "https://192.168.1.10:9443/events",
    ]);
  });

  test("persists disconnect by clearing the stored active session", async () => {
    let cleanupCalls = 0;
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        return new Response("", { status: 404 });
      }) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async () => {
        return () => {
          cleanupCalls += 1;
        };
      }),
    );

    const client = new SecureTransportClient();
    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await client.disconnect();

    expect(cleanupCalls).toBe(1);
    expect(secureStoreValues.has("cowork.h3.activeSession.v1")).toBe(false);

    const restoredSnapshot = await new SecureTransportClient().getSnapshot();
    expect(restoredSnapshot).toMatchObject({
      status: "idle",
      connectedMacDeviceId: null,
      relayUrl: null,
    });
  });

  test("clears active connection and emits close when the event stream ends", async () => {
    const socketClosed = mock((_reason: string | null) => {});
    const client = new SecureTransportClient();
    client.subscribe({ onSocketClosed: socketClosed });
    __internal.setPinnedHttpsFetchForTesting(
      mock(
        async () => Response.json({ sessionToken: "session-token" }) as unknown as Response,
      ) as never,
    );
    globalThis.fetch = mock(async (_input: RequestInfo | URL) => {
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => socketClosed.mock.calls.length === 1);

    expect(socketClosed).toHaveBeenCalledWith("Event stream closed.");
    expect(await client.getSnapshot()).toMatchObject({
      status: "idle",
      connectedMacDeviceId: null,
      relayUrl: null,
    });
  });

  test("emits an error state when pairing fails", async () => {
    const states: string[] = [];
    const secureErrors: string[] = [];
    const client = new SecureTransportClient();
    client.subscribe({
      onStateChanged: (snapshot) => states.push(snapshot.status),
      onSecureError: (message) => secureErrors.push(message),
    });
    __internal.setPinnedHttpsFetchForTesting(async () => new Response("", { status: 503 }));

    await expect(
      client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] })),
    ).rejects.toThrow("Pairing failed against all advertised hosts");

    expect(states).toEqual(["pairing", "error"]);
    expect(secureErrors[0]).toContain("Pairing failed against all advertised hosts");
    expect(await client.getSnapshot()).toMatchObject({
      status: "idle",
      connectedMacDeviceId: null,
      lastError: expect.stringContaining("Pairing failed against all advertised hosts"),
    });
  });

  test("aborts an existing event stream before retrying QR pairing", async () => {
    const plaintextMessages: string[] = [];
    let pairAttempts = 0;
    let cleanupCalls = 0;
    let streamHandlers:
      | Parameters<NonNullable<Parameters<typeof __internal.setPinnedHttpsStreamForTesting>[0]>>[1]
      | null = null;
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (request.url.endsWith("/pair")) {
          pairAttempts += 1;
          if (pairAttempts === 1) {
            return Response.json({ sessionToken: "session-token" }) as unknown as Response;
          }
          return new Response("", { status: 503 });
        }
        return new Response("", { status: 404 });
      }) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async (_request, handlers) => {
        streamHandlers = handlers;
        return () => {
          cleanupCalls += 1;
        };
      }),
    );

    const client = new SecureTransportClient();
    client.subscribe({
      onPlaintextMessage: (text) => plaintextMessages.push(text),
    });

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => streamHandlers !== null);

    await expect(
      client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] })),
    ).rejects.toThrow("Pairing failed against all advertised hosts");

    streamHandlers?.onChunk("data: stale\n\n");

    expect(cleanupCalls).toBe(1);
    expect(plaintextMessages).toEqual([]);
    expect(await client.getSnapshot()).toMatchObject({
      status: "idle",
      connectedMacDeviceId: null,
      lastError: expect.stringContaining("Pairing failed against all advertised hosts"),
    });
  });

  test("clears stale errors when reconnecting a trusted desktop", async () => {
    const socketClosed = mock((_reason: string | null) => {});
    const client = new SecureTransportClient();
    client.subscribe({ onSocketClosed: socketClosed });
    __internal.setPinnedHttpsFetchForTesting(
      mock(
        async () => Response.json({ sessionToken: "session-token" }) as unknown as Response,
      ) as never,
    );
    globalThis.fetch = mock(async (_input: RequestInfo | URL) => {
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => socketClosed.mock.calls.length === 1);

    const snapshot = await client.reconnectTrustedDesktop("desktop-identity");

    expect(snapshot).toMatchObject({
      status: "connected",
      connectedMacDeviceId: "desktop-identity",
      lastError: null,
    });
    expect(JSON.parse(secureStoreValues.get("cowork.h3.activeSession.v1") ?? "null")).toEqual({
      macDeviceId: "desktop-identity",
      endpointUrl: "https://192.168.1.10:9443",
      sessionToken: "session-token",
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
    });
  });

  test("falls back to empty trusted state when secure store JSON is malformed", async () => {
    secureStoreValues.set("cowork.h3.trustedDesktops.v1", "{not-json");
    secureStoreValues.set(
      "cowork.h3.activeSession.v1",
      JSON.stringify({
        macDeviceId: "desktop-identity",
        endpointUrl: "https://192.168.1.10:9443",
        sessionToken: "session-token",
      }),
    );

    const client = new SecureTransportClient();
    const snapshot = await client.getSnapshot();

    expect(snapshot).toMatchObject({
      status: "idle",
      connectedMacDeviceId: null,
      relayUrl: null,
      trustedDesktops: [],
    });
  });

  test("ignores unexpected secure store shapes during restore", async () => {
    secureStoreValues.set(
      "cowork.h3.trustedDesktops.v1",
      JSON.stringify({ macDeviceId: "desktop-identity" }),
    );
    secureStoreValues.set("cowork.h3.activeSession.v1", JSON.stringify(["not", "an", "object"]));

    const client = new SecureTransportClient();
    const snapshot = await client.getSnapshot();

    expect(snapshot).toMatchObject({
      status: "idle",
      connectedMacDeviceId: null,
      relayUrl: null,
      trustedDesktops: [],
    });
  });
});
