import { describe, expect, test } from "bun:test";

import {
  base32Decode,
  base32Encode,
  type CoworkPairingTicket,
  createPairingNonce,
  decodeCoworkPairingTicket,
  encodeCoworkPairingTicket,
} from "../src/shared/coworkTicket";

describe("cowork pairing tickets", () => {
  test("base32 round trips bytes without padding", () => {
    const input = new TextEncoder().encode("hello cowork");
    const encoded = base32Encode(input);

    expect(encoded).not.toContain("=");
    expect(new TextDecoder().decode(base32Decode(encoded))).toBe("hello cowork");
  });

  test("encodes and decodes a direct H3 pairing ticket", () => {
    const ticket: CoworkPairingTicket = {
      v: 1,
      scheme: "h3",
      hosts: ["192.168.1.24", "cowork.local"],
      port: 47777,
      certSha256: "a".repeat(64),
      spkiSha256: "A".repeat(43),
      identityPub: "server-key",
      nonce: createPairingNonce(),
      expiresAt: Date.now() + 60_000,
    };

    const encoded = encodeCoworkPairingTicket(ticket);

    expect(encoded.startsWith("cowork-pair://")).toBe(true);
    expect(decodeCoworkPairingTicket(encoded)).toEqual(ticket);
  });

  test("rejects tickets with the wrong scheme", () => {
    expect(() => decodeCoworkPairingTicket("https://example.invalid")).toThrow(
      "Pairing ticket must start with cowork-pair://.",
    );
  });
});
