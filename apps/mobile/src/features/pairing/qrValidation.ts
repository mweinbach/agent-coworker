import { decodeCoworkPairingTicket } from "../../../../../src/shared/coworkTicket";
import type { PairingQrPayload } from "./pairingTypes";

export function parsePairingQrPayload(rawValue: string): PairingQrPayload {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("cowork-pair://")) {
    throw new Error("Scan the direct Cowork pairing QR shown by desktop.");
  }
  const payload = decodeCoworkPairingTicket(trimmed);
  if (payload.expiresAt <= Date.now()) {
    throw new Error("This pairing code has expired. Generate a new QR code from desktop.");
  }
  return { ...payload, rawTicket: trimmed };
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
