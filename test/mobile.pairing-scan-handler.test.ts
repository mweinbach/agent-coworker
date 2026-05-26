import { describe, expect, mock, test } from "bun:test";
import type { PairingQrPayload } from "../apps/mobile/src/features/pairing/pairingTypes";
import { createPairingScanHandler } from "../apps/mobile/src/features/pairing/scanHandler";

function buildPayload(): PairingQrPayload {
  return {
    v: 1,
    scheme: "h3",
    hosts: ["192.168.1.10"],
    port: 9443,
    certSha256: "a".repeat(64),
    spkiSha256: "b".repeat(43),
    identityPub: "identity-public-key",
    nonce: "pairing-nonce",
    expiresAt: Date.now() + 60_000,
    rawTicket: "cowork-pair://ticket",
  };
}

describe("mobile pairing scan handler", () => {
  test("ignores duplicate scans while a pairing attempt is already in flight", async () => {
    const payload = buildPayload();
    let resolveConnect: (() => void) | null = null;
    const connectWithQr = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const setScannedPayload = mock(() => {});
    const onSuccess = mock(() => {});
    const onInvalidPayload = mock(() => {});
    const onPairingError = mock(() => {});

    const handler = createPairingScanHandler({
      validatePairingPayload: () => ({ success: true, data: payload }),
      connectWithQr,
      setScannedPayload,
      onSuccess,
      onInvalidPayload,
      onPairingError,
    });

    const firstScan = handler.handleScan({ data: JSON.stringify(payload) });
    const secondScan = handler.handleScan({ data: JSON.stringify(payload) });

    await Promise.resolve();
    expect(connectWithQr).toHaveBeenCalledTimes(1);
    expect(setScannedPayload).toHaveBeenCalledTimes(1);
    expect(handler.isPairingAttemptInFlight()).toBe(true);

    resolveConnect?.();
    await firstScan;
    await secondScan;

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onInvalidPayload).not.toHaveBeenCalled();
    expect(onPairingError).not.toHaveBeenCalled();
  });

  test("releases the single-flight guard after a failed pairing attempt", async () => {
    const payload = buildPayload();
    const connectWithQr = mock(async () => {
      throw new Error("offline");
    });
    const setScannedPayload = mock(() => {});
    const onSuccess = mock(() => {});
    const onInvalidPayload = mock(() => {});
    const onPairingError = mock(() => {});

    const handler = createPairingScanHandler({
      validatePairingPayload: () => ({ success: true, data: payload }),
      connectWithQr,
      setScannedPayload,
      onSuccess,
      onInvalidPayload,
      onPairingError,
    });

    await handler.handleScan({ data: JSON.stringify(payload) });
    await handler.handleScan({ data: JSON.stringify(payload) });

    expect(connectWithQr).toHaveBeenCalledTimes(2);
    expect(setScannedPayload).toHaveBeenNthCalledWith(2, null);
    expect(setScannedPayload).toHaveBeenNthCalledWith(4, null);
    expect(onPairingError).toHaveBeenCalledTimes(2);
    expect(onPairingError).toHaveBeenLastCalledWith("offline");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test("reports invalid QR payloads without starting a pairing attempt", async () => {
    const connectWithQr = mock(async () => {});
    const setScannedPayload = mock(() => {});
    const onSuccess = mock(() => {});
    const onInvalidPayload = mock(() => {});
    const onPairingError = mock(() => {});

    const handler = createPairingScanHandler({
      validatePairingPayload: () => ({ success: false, error: "not a Cowork QR" }),
      connectWithQr,
      setScannedPayload,
      onSuccess,
      onInvalidPayload,
      onPairingError,
    });

    await handler.handleScan({ data: "nope" });

    expect(connectWithQr).not.toHaveBeenCalled();
    expect(setScannedPayload).not.toHaveBeenCalled();
    expect(onInvalidPayload).toHaveBeenCalledWith("not a Cowork QR");
    expect(onPairingError).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
