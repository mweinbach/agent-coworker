import { describe, expect, mock, test } from "bun:test";

import { createPairingScanHandler } from "../apps/mobile/src/features/pairing/scanHandler";
import type { PairingQrPayload } from "../apps/mobile/src/features/pairing/pairingTypes";
import { RELAY_PAIRING_QR_VERSION } from "../src/shared/mobileRelaySecurity";

function buildPayload(): PairingQrPayload {
  return {
    v: RELAY_PAIRING_QR_VERSION,
    relay: "wss://relay.example.test/relay",
    sessionId: "session-1",
    macDeviceId: "mac-1",
    macIdentityPublicKey: "ZmFrZS1rZXk=",
    pairingSecret: "pairing-secret-1",
    expiresAt: Date.now() + 60_000,
  };
}

describe("mobile pairing scan handler", () => {
  test("ignores duplicate scans while a pairing attempt is already in flight", async () => {
    const payload = buildPayload();
    let resolveConnect: (() => void) | null = null;
    const connectWithQr = mock(() => new Promise<void>((resolve) => {
      resolveConnect = resolve;
    }));
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
});
