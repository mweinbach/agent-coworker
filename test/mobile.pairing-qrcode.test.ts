import { describe, expect, test } from "bun:test";

import {
  parsePairingQrPayload,
  validatePairingPayload,
} from "../app/mobile/src/features/pairing/qrValidation";

function buildPayload(overrides?: Partial<{
  expiresAt: number;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
}>) {
  return {
    v: 2,
    relay: overrides?.relay ?? "wss://relay.example.test/relay",
    sessionId: overrides?.sessionId ?? "session-1",
    macDeviceId: overrides?.macDeviceId ?? "mac-1",
    macIdentityPublicKey: overrides?.macIdentityPublicKey ?? "ZmFrZS1rZXk=",
    expiresAt: overrides?.expiresAt ?? Date.now() + 60_000,
  };
}

describe("mobile pairing QR validation", () => {
  test("parses a valid pairing payload", () => {
    const payload = buildPayload();
    expect(parsePairingQrPayload(JSON.stringify(payload))).toEqual(payload);
  });

  test("rejects expired pairing payloads", () => {
    const parsed = validatePairingPayload(JSON.stringify(buildPayload({
      expiresAt: Date.now() - 1_000,
    })));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error).toContain("expired");
    }
  });

  test("rejects malformed payloads", () => {
    const parsed = validatePairingPayload(JSON.stringify({
      v: 2,
      relay: "",
    }));
    expect(parsed.success).toBe(false);
  });
});
