import { z } from "zod";

import { RELAY_PAIRING_QR_VERSION } from "../../../../../src/shared/mobileRelaySecurity";
import type { PairingQrPayload } from "./pairingTypes";

const pairingQrPayloadSchema = z.object({
  v: z.literal(RELAY_PAIRING_QR_VERSION),
  relay: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  macDeviceId: z.string().trim().min(1),
  macIdentityPublicKey: z.string().trim().min(1),
  pairingSecret: z.string().trim().min(1),
  expiresAt: z.number().int().positive(),
}).strict();

export function parsePairingQrPayload(rawValue: string): PairingQrPayload {
  const parsedJson = JSON.parse(rawValue) as unknown;
  const payload = pairingQrPayloadSchema.parse(parsedJson);
  if (payload.expiresAt <= Date.now()) {
    throw new Error("This pairing code has expired. Generate a new QR code from desktop.");
  }
  return payload;
}

export function validatePairingPayload(rawValue: string):
  | { success: true; data: PairingQrPayload }
  | { success: false; error: string } {
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
