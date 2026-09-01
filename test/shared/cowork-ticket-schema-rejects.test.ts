import { describe, expect, test } from "bun:test";

import {
  base32Encode,
  type CoworkPairingTicket,
  decodeCoworkPairingTicket,
  encodeCoworkPairingTicket,
} from "../../src/shared/coworkTicket";

const validTicket: CoworkPairingTicket = {
  v: 1,
  scheme: "h3",
  hosts: ["192.168.1.24"],
  port: 47777,
  certSha256: "a".repeat(64),
  spkiSha256: "A".repeat(43),
  identityPub: "server-key",
  nonce: "abcdefghijklmnopqrstuv",
  expiresAt: 1_776_000_000_000,
};

function encodeRawPayload(payload: string): string {
  return `cowork-pair://${base32Encode(new TextEncoder().encode(payload))}`;
}

describe("cowork pairing ticket schema rejects", () => {
  test("encode fails closed on extra keys, invalid hashes, and out-of-range fields", () => {
    expect(encodeCoworkPairingTicket(validTicket).startsWith("cowork-pair://")).toBe(true);

    expect(() =>
      encodeCoworkPairingTicket({
        ...validTicket,
        extra: true,
      } as CoworkPairingTicket),
    ).toThrow();
    expect(() =>
      encodeCoworkPairingTicket({ ...validTicket, v: 2 } as CoworkPairingTicket),
    ).toThrow();
    expect(() =>
      encodeCoworkPairingTicket({ ...validTicket, scheme: "ws" } as CoworkPairingTicket),
    ).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...validTicket, hosts: [] })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...validTicket, hosts: ["   "] })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...validTicket, port: 0 })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...validTicket, port: 65_536 })).toThrow();
    expect(() =>
      encodeCoworkPairingTicket({ ...validTicket, certSha256: "A".repeat(64) }),
    ).toThrow();
    expect(() =>
      encodeCoworkPairingTicket({ ...validTicket, certSha256: "a".repeat(63) }),
    ).toThrow();
    expect(() =>
      encodeCoworkPairingTicket({ ...validTicket, spkiSha256: "A".repeat(42) }),
    ).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...validTicket, nonce: "shortnonce" })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...validTicket, expiresAt: 0 })).toThrow();
    expect(() => encodeCoworkPairingTicket({ ...validTicket, identityPub: "   " })).toThrow();
  });

  test("decode rejects empty payloads, invalid base32, non-JSON, and schema-invalid tickets", () => {
    expect(() => decodeCoworkPairingTicket("cowork-pair://")).toThrow("Pairing ticket is empty.");
    expect(() => decodeCoworkPairingTicket("  cowork-pair://  ")).toThrow(
      "Pairing ticket is empty.",
    );
    expect(() => decodeCoworkPairingTicket("cowork-pair://!!!")).toThrow(
      "Pairing ticket contains invalid base32 data.",
    );
    expect(() => decodeCoworkPairingTicket(encodeRawPayload("not-json"))).toThrow();
    expect(() => decodeCoworkPairingTicket(encodeRawPayload(JSON.stringify({ v: 1 })))).toThrow();
    expect(() =>
      decodeCoworkPairingTicket(
        encodeRawPayload(
          JSON.stringify({
            ...validTicket,
            extra: true,
          }),
        ),
      ),
    ).toThrow();
  });

  test("decode trims surrounding whitespace and accepts mixed-case base32 payloads", () => {
    const encoded = encodeCoworkPairingTicket(validTicket);
    const prefix = "cowork-pair://";
    const payload = encoded.slice(prefix.length);
    expect(decodeCoworkPairingTicket(`  ${encoded}  `)).toEqual(validTicket);
    expect(decodeCoworkPairingTicket(`${prefix}${payload.toUpperCase()}`)).toEqual(validTicket);
    expect(() => decodeCoworkPairingTicket(encoded.toUpperCase())).toThrow(
      "Pairing ticket must start with cowork-pair://.",
    );
  });
});
