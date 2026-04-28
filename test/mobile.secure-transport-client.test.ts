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
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    __internal.setSecureStoreForTesting(null);
    __internal.setPinnedHttpsFetchForTesting(null);
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

    expect(snapshot.status).toBe("connected");
    expect(snapshot.relayUrl).toBe("https://192.168.1.10:9443");
    expect(requestedUrls).toEqual([
      "https://unreachable.local:9443/pair",
      "https://192.168.1.10:9443/pair",
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toMatchObject({
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
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
  });
});
