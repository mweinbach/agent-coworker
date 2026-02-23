import { z } from "zod";

import type { ServerErrorCode } from "../../types";

import { safeParseClientMessage, type ClientMessage, type ServerEvent } from "../protocol";

const websocketMessageRawSchema = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer),
]);

type DecodedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; event: ServerEvent };

function protocolErrorCode(error: string): ServerErrorCode {
  if (error === "Invalid JSON") return "invalid_json";
  if (error === "Expected object") return "invalid_payload";
  if (error === "Missing type") return "missing_type";
  if (error.startsWith("Unknown type:")) return "unknown_type";
  return "validation_failed";
}

export function buildProtocolErrorEvent(sessionId: string, message: string, code: ServerErrorCode): ServerEvent {
  return {
    type: "error",
    sessionId,
    message,
    code,
    source: "protocol",
  };
}

export function decodeClientMessage(raw: unknown, sessionId: string): DecodedClientMessage {
  const parsedRaw = websocketMessageRawSchema.safeParse(raw);
  if (!parsedRaw.success) {
    return {
      ok: false,
      event: buildProtocolErrorEvent(sessionId, "Invalid JSON", "invalid_json"),
    };
  }

  const text =
    typeof parsedRaw.data === "string"
      ? parsedRaw.data
      : Buffer.from(parsedRaw.data).toString("utf-8");
  const parsed = safeParseClientMessage(text);
  if (!parsed.ok) {
    return {
      ok: false,
      event: buildProtocolErrorEvent(sessionId, parsed.error, protocolErrorCode(parsed.error)),
    };
  }

  return { ok: true, message: parsed.msg };
}
