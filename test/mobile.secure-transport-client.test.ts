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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    expect(
      JSON.parse((fetchMock.mock.calls[1]?.[0] as { body?: string }).body ?? "{}"),
    ).toMatchObject({
      ticket: "cowork-pair://ticket",
      nonce: "pairing-nonce",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toMatchObject({
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
    });
  });

  test("falls back to simulator loopback hosts after advertised pairing endpoints fail", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = mock(async (request: { url: string }) => {
      requestedUrls.push(request.url);
      if (request.url === "https://127.0.0.1:9443/pair") {
        return Response.json({ sessionToken: "session-token" }) as unknown as Response;
      }
      if (request.url === "https://127.0.0.1:9443/events") {
        return new Response("", { status: 200 });
      }
      throw new Error("network unreachable");
    });
    __internal.setPinnedHttpsFetchForTesting(fetchMock as never);

    const client = new SecureTransportClient();
    const snapshot = await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => requestedUrls.some((url) => url.endsWith("/events")));

    expect(snapshot.status).toBe("connected");
    expect(snapshot.relayUrl).toBe("https://127.0.0.1:9443");
    expect(requestedUrls).toEqual([
      "https://192.168.1.10:9443/pair",
      "https://127.0.0.1:9443/pair",
      "https://127.0.0.1:9443/events",
    ]);
    expect(
      JSON.parse((fetchMock.mock.calls[1]?.[0] as { body?: string }).body ?? "{}"),
    ).toMatchObject({
      ticket: "cowork-pair://ticket",
      nonce: "pairing-nonce",
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
    const requests: Array<{
      url: string;
      method: string;
      body?: string;
      headers?: Record<string, string>;
    }> = [];
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

    const pairedDeviceId = JSON.parse(
      requests.find((request) => request.url.endsWith("/pair"))?.body ?? "{}",
    ).deviceId;
    expect(requests.find((request) => request.url.endsWith("/rpc"))).toMatchObject({
      url: "https://192.168.1.10:9443/rpc",
      method: "POST",
      body: '{"jsonrpc":"2.0","method":"thread/list","id":1}',
      headers: {
        authorization: "Bearer session-token",
        "x-cowork-mobile-device-id": pairedDeviceId,
        "content-type": "application/json",
      },
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
    });
    expect(plaintextMessages).toEqual(["server-response"]);
  });

  test("does not deliver HTTP notification ack bodies as plaintext messages", async () => {
    const plaintextMessages: string[] = [];
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        if (request.url.endsWith("/events")) {
          return new Response("", { status: 200 });
        }
        if (request.url.endsWith("/rpc")) {
          return Response.json({ ok: true }, { status: 202 }) as unknown as Response;
        }
        return new Response("", { status: 404 });
      }) as never,
    );
    const client = new SecureTransportClient();
    client.subscribe({
      onPlaintextMessage: (text) => plaintextMessages.push(text),
    });

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await client.sendPlaintext('{"method":"initialized","params":{}}');

    expect(plaintextMessages).toEqual([]);
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
    expect(JSON.parse(secureStoreValues.get("cowork.h3.trustedDesktops.v2") ?? "[]")).toEqual([
      expect.objectContaining({
        macDeviceId: "desktop-identity",
        mobileDeviceId: pairedDeviceIds[0],
      }),
    ]);
    expect(secureStoreValues.get("cowork.h3.trustedDesktops.v2")).not.toContain("session-2");
    expect(secureStoreValues.get("cowork_session_token_desktop-identity")).toBe("session-2");
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

  test("keeps the active session and reopens the event stream when the stream ends", async () => {
    const states: string[] = [];
    const socketClosed = mock((_reason: string | null) => {});
    const streamUrls: string[] = [];
    const streamHandlers: Array<
      Parameters<NonNullable<Parameters<typeof __internal.setPinnedHttpsStreamForTesting>[0]>>[1]
    > = [];
    const client = new SecureTransportClient({
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
    });
    client.subscribe({
      onStateChanged: (snapshot) => states.push(snapshot.status),
      onSocketClosed: socketClosed,
    });
    __internal.setPinnedHttpsFetchForTesting(
      mock(
        async () => Response.json({ sessionToken: "session-token" }) as unknown as Response,
      ) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async (request, handlers) => {
        streamUrls.push(request.url);
        streamHandlers.push(handlers);
        return () => {};
      }),
    );

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => streamHandlers.length === 1);

    streamHandlers[0]?.onClose("network down");

    expect(socketClosed).toHaveBeenCalledWith("network down");
    expect(states).toContain("reconnecting");
    expect(secureStoreValues.has("cowork.h3.activeSession.v1")).toBe(true);
    await waitFor(() => streamUrls.length === 2);
    expect(await client.getSnapshot()).toMatchObject({
      status: "connected",
      connectedMacDeviceId: "desktop-identity",
      relayUrl: "https://192.168.1.10:9443",
    });
  });

  test("cancels scheduled reconnects and ignores stale stream chunks after disconnect", async () => {
    const plaintextMessages: string[] = [];
    const streamUrls: string[] = [];
    const streamHandlers: Array<
      Parameters<NonNullable<Parameters<typeof __internal.setPinnedHttpsStreamForTesting>[0]>>[1]
    > = [];
    const client = new SecureTransportClient({
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 20,
    });
    client.subscribe({
      onPlaintextMessage: (text) => plaintextMessages.push(text),
    });
    __internal.setPinnedHttpsFetchForTesting(
      mock(
        async () => Response.json({ sessionToken: "session-token" }) as unknown as Response,
      ) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async (request, handlers) => {
        streamUrls.push(request.url);
        streamHandlers.push(handlers);
        return () => {};
      }),
    );

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => streamHandlers.length === 1);

    streamHandlers[0]?.onClose("network down");
    await client.disconnect();
    streamHandlers[0]?.onChunk("data: stale\n\n");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(streamUrls).toEqual(["https://192.168.1.10:9443/events"]);
    expect(plaintextMessages).toEqual([]);
    expect(secureStoreValues.has("cowork.h3.activeSession.v1")).toBe(false);
    expect(await client.getSnapshot()).toMatchObject({
      status: "idle",
      connectedMacDeviceId: null,
      relayUrl: null,
    });
  });

  test("stops reconnecting and asks for a fresh QR after repeated certificate failures", async () => {
    const states: string[] = [];
    const client = new SecureTransportClient({
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
      maxReconnectAttempts: 2,
    });
    client.subscribe({
      onStateChanged: (snapshot) => states.push(snapshot.status),
    });
    __internal.setPinnedHttpsFetchForTesting(
      mock(
        async () => Response.json({ sessionToken: "session-token" }) as unknown as Response,
      ) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async (_request, handlers) => {
        handlers.onError("Pinned HTTPS certificate mismatch.");
        return () => {};
      }),
    );

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => states.includes("error"));

    expect(await client.getSnapshot()).toMatchObject({
      status: "error",
      connectedMacDeviceId: null,
      relayUrl: null,
      lastError: expect.stringContaining("Scan the QR code again"),
    });
    expect(secureStoreValues.has("cowork.h3.activeSession.v1")).toBe(false);
  });

  test("clears the active session instead of reconnecting after authorization failures", async () => {
    const secureErrors: string[] = [];
    const states: string[] = [];
    const client = new SecureTransportClient({
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });
    client.subscribe({
      onSecureError: (message) => secureErrors.push(message),
      onStateChanged: (snapshot) => states.push(snapshot.status),
    });
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        if (request.url.endsWith("/events")) {
          return new Response("", { status: 401 });
        }
        return new Response("", { status: 404 });
      }) as never,
    );

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => secureErrors.length === 1);
    await waitFor(() => !secureStoreValues.has("cowork.h3.activeSession.v1"));

    expect(secureErrors[0]).toContain("HTTP 401");
    expect(states).toContain("error");
    expect(secureStoreValues.has("cowork.h3.activeSession.v1")).toBe(false);
    expect(await client.getSnapshot()).toMatchObject({
      status: "error",
      connectedMacDeviceId: null,
      relayUrl: null,
      lastError: expect.stringContaining("HTTP 401"),
    });
  });

  test("does not restore a fatal session while active session deletion is pending", async () => {
    const secureErrors: string[] = [];
    const releaseActiveDelete = createDeferred<void>();
    __internal.setSecureStoreForTesting({
      getItemAsync: secureStore.getItemAsync,
      setItemAsync: secureStore.setItemAsync,
      deleteItemAsync: mock(async (key: string) => {
        if (key === "cowork.h3.activeSession.v1") {
          await releaseActiveDelete.promise;
        }
        secureStoreValues.delete(key);
      }),
    });
    const client = new SecureTransportClient({
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });
    client.subscribe({
      onSecureError: (message) => secureErrors.push(message),
    });
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        if (request.url.endsWith("/events")) {
          return new Response("", { status: 401 });
        }
        return new Response("", { status: 404 });
      }) as never,
    );

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    await waitFor(() => secureErrors.length === 1);

    expect(secureStoreValues.has("cowork.h3.activeSession.v1")).toBe(true);
    expect(await client.getSnapshot()).toMatchObject({
      status: "error",
      connectedMacDeviceId: null,
      relayUrl: null,
      lastError: expect.stringContaining("HTTP 401"),
    });

    releaseActiveDelete.resolve();
    await waitFor(() => !secureStoreValues.has("cowork.h3.activeSession.v1"));
  });

  test("forgetting an inactive trusted desktop preserves the active connection", async () => {
    const streamUrls: string[] = [];
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string; body?: string }) => {
        if (request.url.endsWith("/pair")) {
          const body = JSON.parse(request.body ?? "{}") as { nonce?: string };
          return Response.json({ sessionToken: `session-${body.nonce ?? "unknown"}` }) as never;
        }
        return new Response("", { status: 404 }) as never;
      }) as never,
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async (request) => {
        streamUrls.push(request.url);
        return () => {};
      }),
    );

    const client = new SecureTransportClient();
    await client.connectFromQrPayload(
      buildPayload({
        hosts: ["192.168.1.10"],
        identityPub: "desktop-one",
        nonce: "pairing-nonce-1",
      }),
    );
    await client.connectFromQrPayload(
      buildPayload({
        hosts: ["192.168.1.10"],
        identityPub: "desktop-two",
        nonce: "pairing-nonce-2",
      }),
    );

    const snapshot = await client.forgetTrustedDesktop("desktop-one");

    expect(snapshot).toMatchObject({
      status: "connected",
      connectedMacDeviceId: "desktop-two",
      relayUrl: "https://192.168.1.10:9443",
      trustedDesktops: [expect.objectContaining({ macDeviceId: "desktop-two" })],
    });
    expect(streamUrls).toEqual([
      "https://192.168.1.10:9443/events",
      "https://192.168.1.10:9443/events",
    ]);
    expect(JSON.parse(secureStoreValues.get("cowork.h3.activeSession.v1") ?? "null")).toEqual({
      macDeviceId: "desktop-two",
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
      status: "error",
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
      status: "error",
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
    });
  });

  test("falls back to empty trusted state when secure store JSON is malformed", async () => {
    secureStoreValues.set("cowork.h3.trustedDesktops.v2", "{not-json");
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
      "cowork.h3.trustedDesktops.v2",
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

  test("clears the active session after consecutive sendPlaintext repin-required failures", async () => {
    const stateChanges: Array<{ status: string; lastError: string | null }> = [];
    let pairing = true;
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (pairing && request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        if (request.url.endsWith("/events")) {
          return await new Promise<Response>(() => {});
        }
        if (request.url.endsWith("/rpc")) {
          throw new Error("Network request failed: Could not connect to the server");
        }
        return new Response("", { status: 404 });
      }) as never,
    );

    const client = new SecureTransportClient({ maxConsecutiveRequestFailures: 2 });
    client.subscribe({
      onStateChanged: (snapshot) =>
        stateChanges.push({ status: snapshot.status, lastError: snapshot.lastError }),
    });

    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    pairing = false;

    await expect(client.sendPlaintext("{}")).rejects.toThrow(/Could not connect/);
    expect((await client.getSnapshot()).status).toBe("connected");

    await expect(client.sendPlaintext("{}")).rejects.toThrow(/Could not connect/);

    const snapshot = await client.getSnapshot();
    expect(snapshot).toMatchObject({
      status: "error",
      connectedMacDeviceId: null,
      lastError: expect.stringContaining("Scan the QR code again"),
    });
    expect(
      stateChanges.some(
        (change) =>
          change.status === "error" && change.lastError?.includes("Scan the QR code again"),
      ),
    ).toBe(true);
  });

  test("does not clear the active session on transient non-repin sendPlaintext failures", async () => {
    let pairing = true;
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (pairing && request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        if (request.url.endsWith("/events")) {
          return await new Promise<Response>(() => {});
        }
        if (request.url.endsWith("/rpc")) {
          return new Response("error", { status: 500 });
        }
        return new Response("", { status: 404 });
      }) as never,
    );

    const client = new SecureTransportClient({ maxConsecutiveRequestFailures: 2 });
    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    pairing = false;

    await expect(client.sendPlaintext("{}")).rejects.toThrow(/HTTP 500/);
    await expect(client.sendPlaintext("{}")).rejects.toThrow(/HTTP 500/);
    await expect(client.sendPlaintext("{}")).rejects.toThrow(/HTTP 500/);

    expect((await client.getSnapshot()).status).toBe("connected");
  });

  test("resets the sendPlaintext failure counter on a successful round-trip", async () => {
    let pairing = true;
    let rpcShouldFail = true;
    __internal.setPinnedHttpsFetchForTesting(
      mock(async (request: { url: string }) => {
        if (pairing && request.url.endsWith("/pair")) {
          return Response.json({ sessionToken: "session-token" }) as unknown as Response;
        }
        if (request.url.endsWith("/events")) {
          return await new Promise<Response>(() => {});
        }
        if (request.url.endsWith("/rpc")) {
          if (rpcShouldFail) {
            throw new Error("Network request failed: Could not connect to the server");
          }
          return new Response("", { status: 200 });
        }
        return new Response("", { status: 404 });
      }) as never,
    );

    const client = new SecureTransportClient({ maxConsecutiveRequestFailures: 2 });
    await client.connectFromQrPayload(buildPayload({ hosts: ["192.168.1.10"] }));
    pairing = false;

    await expect(client.sendPlaintext("{}")).rejects.toThrow(/Could not connect/);
    rpcShouldFail = false;
    await client.sendPlaintext("{}");
    rpcShouldFail = true;
    await expect(client.sendPlaintext("{}")).rejects.toThrow(/Could not connect/);

    expect((await client.getSnapshot()).status).toBe("connected");
  });

  test("restores active sessions from trusted desktop records instead of stored endpoint details", async () => {
    const streamRequests: Array<{
      url: string;
      headers?: Record<string, string>;
      certSha256: string;
      spkiSha256: string;
    }> = [];
    secureStoreValues.set(
      "cowork.h3.trustedDesktops.v2",
      JSON.stringify([
        {
          macDeviceId: "desktop-identity",
          relayUrl: "https://trusted.example:9443",
          displayName: "Cowork Desktop",
          publicKey: "desktop-identity",
          fingerprint: "trusted-fingerprint",
          lastConnectedAt: "2026-05-23T00:00:00.000Z",
          endpointUrl: "https://trusted.example:9443",
          certSha256: "c".repeat(64),
          spkiSha256: "d".repeat(43),
        },
      ]),
    );
    secureStoreValues.set("cowork.h3.mobileDeviceId.v1", "cowork-mobile-existing");
    secureStoreValues.set("cowork_session_token_desktop-identity", "trusted-token");
    secureStoreValues.set(
      "cowork.h3.activeSession.v1",
      JSON.stringify({
        macDeviceId: "desktop-identity",
        endpointUrl: "https://attacker.example:9443",
        sessionToken: "attacker-token",
        certSha256: "e".repeat(64),
        spkiSha256: "f".repeat(43),
      }),
    );
    __internal.setPinnedHttpsStreamForTesting(
      mock(async (request) => {
        streamRequests.push(request);
        return () => {};
      }),
    );

    const snapshot = await new SecureTransportClient().getSnapshot();
    await waitFor(() => streamRequests.length === 1);

    expect(snapshot).toMatchObject({
      status: "connected",
      connectedMacDeviceId: "desktop-identity",
      relayUrl: "https://trusted.example:9443",
    });
    expect(streamRequests[0]).toMatchObject({
      url: "https://trusted.example:9443/events",
      headers: {
        authorization: "Bearer trusted-token",
        "x-cowork-mobile-device-id": "cowork-mobile-existing",
      },
      certSha256: "c".repeat(64),
      spkiSha256: "d".repeat(43),
    });
  });
});
