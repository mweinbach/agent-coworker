import { z } from "zod";

const TICKET_PREFIX = "cowork-pair://";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE32_LOOKUP = new Map([...BASE32_ALPHABET].map((char, index) => [char, index]));

export const coworkPairingTicketSchema = z
  .object({
    v: z.literal(1),
    scheme: z.literal("h3"),
    hosts: z.array(z.string().trim().min(1)).min(1),
    port: z.number().int().min(1).max(65535),
    certSha256: z.string().regex(/^[a-f0-9]{64}$/),
    spkiSha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    identityPub: z.string().trim().min(1),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type CoworkPairingTicket = z.infer<typeof coworkPairingTicketSchema>;

export function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let value = 0;
  let bits = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(input: string): Uint8Array {
  const normalized = input.toLowerCase().replace(/=+$/g, "");
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;

  for (const char of normalized) {
    const chunk = BASE32_LOOKUP.get(char);
    if (chunk === undefined) {
      throw new Error("Pairing ticket contains invalid base32 data.");
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

export function encodeCoworkPairingTicket(ticket: CoworkPairingTicket): string {
  const parsed = coworkPairingTicketSchema.parse(ticket);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  return `${TICKET_PREFIX}${base32Encode(bytes)}`;
}

export function decodeCoworkPairingTicket(rawTicket: string): CoworkPairingTicket {
  const trimmed = rawTicket.trim();
  if (!trimmed.startsWith(TICKET_PREFIX)) {
    throw new Error("Pairing ticket must start with cowork-pair://.");
  }

  const payload = trimmed.slice(TICKET_PREFIX.length);
  if (!payload) {
    throw new Error("Pairing ticket is empty.");
  }

  const json = new TextDecoder().decode(base32Decode(payload));
  return coworkPairingTicketSchema.parse(JSON.parse(json));
}

export function createPairingNonce(byteLength = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Buffer.from(bytes).toString("base64url");
}
