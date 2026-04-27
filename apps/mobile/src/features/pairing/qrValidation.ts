import { z } from "zod";

import type { PairingQrPayload } from "./pairingTypes";

const pairingQrPayloadSchema = z
  .object({
    v: z.literal(1),
    scheme: z.literal("h3"),
    hosts: z.array(z.string().trim().min(1)).min(1),
    port: z.number().int().min(1).max(65535),
    certSha256: z.string().regex(/^[a-f0-9]{64}$/),
    spkiSha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    identityPub: z.string().trim().min(1),
    nonce: z.string().trim().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const TICKET_PREFIX = "cowork-pair://";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE32_LOOKUP = new Map([...BASE32_ALPHABET].map((char, index) => [char, index]));

function base32Decode(input: string): Uint8Array {
  const normalized = input.toLowerCase().replace(/=+$/g, "");
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;

  for (const char of normalized) {
    const chunk = BASE32_LOOKUP.get(char);
    if (chunk === undefined) {
      throw new Error("Pairing ticket contains invalid data.");
    }
    value = (value << 5) | chunk;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

export function parsePairingQrPayload(rawValue: string): PairingQrPayload {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith(TICKET_PREFIX)) {
    throw new Error("Scan the direct Cowork pairing QR shown by desktop.");
  }
  const json = new TextDecoder().decode(base32Decode(trimmed.slice(TICKET_PREFIX.length)));
  const parsedJson = JSON.parse(json) as unknown;
  const payload = pairingQrPayloadSchema.parse(parsedJson);
  if (payload.expiresAt <= Date.now()) {
    throw new Error("This pairing code has expired. Generate a new QR code from desktop.");
  }
  return { ...payload, ticket: trimmed };
}

export function validatePairingPayload(
  rawValue: string,
): { success: true; data: PairingQrPayload } | { success: false; error: string } {
  try {
    return {
      success: true,
      data: parsePairingQrPayload(rawValue),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Invalid pairing payload.",
    };
  }
}
