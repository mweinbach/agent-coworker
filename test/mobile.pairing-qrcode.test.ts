import { describe, expect, test } from "bun:test";
import {
  parsePairingQrPayload,
  validatePairingPayload,
} from "../apps/mobile/src/features/pairing/qrValidation";
import { encodeCoworkPairingTicket } from "../src/shared/coworkTicket";

function buildPayload(
  overrides?: Partial<{
    expiresAt: number;
    hosts: string[];
  }>,
) {
  return {
    v: 1 as const,
    scheme: "h3" as const,
    hosts: overrides?.hosts ?? ["127.0.0.1"],
    port: 12345,
    certSha256: "a".repeat(64),
    spkiSha256: "b".repeat(43),
    identityPub: "identity-pub",
    nonce: "nonce-value-123456789012",
    expiresAt: overrides?.expiresAt ?? Date.now() + 60_000,
  };
}

describe("mobile pairing QR validation", () => {
  test("parses a valid pairing payload", () => {
    const payload = buildPayload();
    expect(parsePairingQrPayload(encodeCoworkPairingTicket(payload))).toEqual({
      ...payload,
      rawTicket: encodeCoworkPairingTicket(payload),
    });
  });

  test("rejects expired pairing payloads", () => {
    const parsed = validatePairingPayload(
      encodeCoworkPairingTicket(
        buildPayload({
          expiresAt: Date.now() - 1_000,
        }),
      ),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error).toContain("expired");
    }
  });

  test("rejects malformed payloads", () => {
    const parsed = validatePairingPayload("not-a-ticket");
    expect(parsed.success).toBe(false);
  });

  test("rejects unsupported pairing payload versions", () => {
    const invalid = {
      ...buildPayload(),
      v: 2,
    };
    const parsed = validatePairingPayload(
      `cowork-pair://${Buffer.from(JSON.stringify(invalid)).toString("base64url")}`,
    );
    expect(parsed.success).toBe(false);
  });
});
