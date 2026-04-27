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
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    __internal.setSecureStoreForTesting(null);
    globalThis.fetch = originalFetch;
  });

  test("tries later advertised hosts when the first pairing endpoint is unreachable", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.startsWith("https://unreachable.local:9443")) {
        throw new Error("network unreachable");
      }
      if (url === "https://192.168.1.10:9443/pair") {
        return Response.json({ sessionToken: "session-token" });
      }
      return new Response("", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new SecureTransportClient();
    const snapshot = await client.connectFromQrPayload(buildPayload());

    expect(snapshot.status).toBe("connected");
    expect(snapshot.relayUrl).toBe("https://192.168.1.10:9443");
    expect(requestedUrls).toContain("https://unreachable.local:9443/pair");
    expect(requestedUrls).toContain("https://192.168.1.10:9443/pair");
  });

  test("clears active connection and emits close when the event stream ends", async () => {
    const socketClosed = mock((_reason: string | null) => {});
    const client = new SecureTransportClient();
    client.subscribe({ onSocketClosed: socketClosed });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pair")) {
        return Response.json({ sessionToken: "session-token" });
      }
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
});
