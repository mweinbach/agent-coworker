import { z } from "zod";

import {
  buildJsonRpcErrorResponse,
  parseJsonRpcClientMessage,
  type JsonRpcLiteClientMessage,
  type JsonRpcLiteResponse,
} from "./protocol";

const websocketMessageRawSchema = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer),
]);

export type DecodedJsonRpcClientMessage =
  | { ok: true; message: JsonRpcLiteClientMessage }
  | { ok: false; response: JsonRpcLiteResponse };

export function decodeJsonRpcMessage(raw: unknown): DecodedJsonRpcClientMessage {
  const parsedRaw = websocketMessageRawSchema.safeParse(raw);
  if (!parsedRaw.success) {
    return {
      ok: false,
      response: buildJsonRpcErrorResponse(null, {
        code: -32700,
        message: "Invalid JSON",
      }),
    };
  }

  const text =
    typeof parsedRaw.data === "string"
      ? parsedRaw.data
      : Buffer.from(
          parsedRaw.data instanceof Uint8Array ? parsedRaw.data : new Uint8Array(parsedRaw.data),
        ).toString("utf-8");

  const parsed = parseJsonRpcClientMessage(text);
  if (!parsed.ok) {
    return {
      ok: false,
      response: buildJsonRpcErrorResponse(parsed.id, parsed.error),
    };
  }

  return {
    ok: true,
    message: parsed.message,
  };
}
