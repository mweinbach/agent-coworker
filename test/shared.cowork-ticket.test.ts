import { describe, expect, test } from "bun:test";
import { decodeCoworkPairingTicket as decodeMobileCoworkPairingTicket } from "../apps/mobile/src/features/pairing/coworkTicket";
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
    expect(decodeMobileCoworkPairingTicket(encoded)).toEqual(ticket);
  });

  test("rejects tickets with the wrong scheme", () => {
    expect(() => decodeCoworkPairingTicket("https://example.invalid")).toThrow(
      "Pairing ticket must start with cowork-pair://.",
    );
  });

  test("rejects invalid tickets before encode", () => {
    const valid: CoworkPairingTicket = {
      v: 1,
      scheme: "h3",
      hosts: ["192.168.1.24"],
      port: 47777,
      certSha256: "a".repeat(64),
      spkiSha256: "A".repeat(43),
      identityPub: "server-key",
      nonce: createPairingNonce(),
      expiresAt: Date.now() + 60_000,
    };

    expect(() =>
      encodeCoworkPairingTicket({ ...valid, extra: true } as CoworkPairingTicket),
    ).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, v: 2 } as CoworkPairingTicket)).toThrow();
    expect(() =>
      encodeCoworkPairingTicket({ ...valid, scheme: "https" } as CoworkPairingTicket),
    ).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, hosts: [] })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, hosts: ["  "] })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, port: 0 })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, port: 65536 })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, certSha256: "A".repeat(64) })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, certSha256: "a".repeat(63) })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, spkiSha256: "A".repeat(42) })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, nonce: "short" })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, expiresAt: 0 })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...valid, identityPub: "  " })).toThrow();
  });

  test("fails closed on empty, malformed, and schema-invalid payloads", () => {
    const ticket: CoworkPairingTicket = {
      v: 1,
      scheme: "h3",
      hosts: ["192.168.1.24"],
      port: 47777,
      certSha256: "a".repeat(64),
      spkiSha256: "A".repeat(43),
      identityPub: "server-key",
      nonce: createPairingNonce(),
      expiresAt: Date.now() + 60_000,
    };
    const encoded = encodeCoworkPairingTicket(ticket);
    const payload = encoded.slice("cowork-pair://".length);

    expect(() => decodeCoworkPairingTicket("cowork-pair://")).toThrow("Pairing ticket is empty.");
    expect(() => decodeCoworkPairingTicket("  cowork-pair://  ")).toThrow(
      "Pairing ticket is empty.",
    );
    expect(() => decodeCoworkPairingTicket(`COWORK-PAIR://${payload}`)).toThrow(
      "Pairing ticket must start with cowork-pair://.",
    );
    expect(() => decodeCoworkPairingTicket("cowork-pair://!!!!")).toThrow(
      "Pairing ticket contains invalid base32 data.",
    );
    expect(() =>
      decodeCoworkPairingTicket(
        `cowork-pair://${base32Encode(new TextEncoder().encode("not-json"))}`,
      ),
    ).toThrow();
    expect(() =>
      decodeCoworkPairingTicket(
        `cowork-pair://${base32Encode(new TextEncoder().encode(JSON.stringify({ v: 1 })))}`,
      ),
    ).toThrow();
    expect(decodeCoworkPairingTicket(`cowork-pair://${payload.toUpperCase()}`)).toEqual(ticket);
  });
});
