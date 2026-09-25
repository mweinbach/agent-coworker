import { describe, expect, test } from "bun:test";

import { decodeJsonRpcMessage } from "../src/server/jsonrpc/decodeJsonRpcMessage";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";

const request = { id: 7, method: "thread/list", params: { cwd: "/workspace" } };
const encoded = JSON.stringify(request);

function parseError(message = "Invalid JSON") {
  return {
    ok: false as const,
    response: {
      id: null,
      error: { code: JSONRPC_ERROR_CODES.parseError, message },
    },
  };
}

describe("decodeJsonRpcMessage", () => {
  test("accepts string, Uint8Array, and ArrayBuffer frames", () => {
    const bytes = new TextEncoder().encode(encoded);
    expect(decodeJsonRpcMessage(encoded)).toEqual({ ok: true, message: request });
    expect(decodeJsonRpcMessage(bytes)).toEqual({ ok: true, message: request });
    expect(
      decodeJsonRpcMessage(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ),
    ).toEqual({
      ok: true,
      message: request,
    });
    expect(decodeJsonRpcMessage(Buffer.from(encoded))).toEqual({ ok: true, message: request });
  });

  test("rejects non-frame payloads before JSON parse", () => {
    expect(decodeJsonRpcMessage(null)).toEqual(parseError());
    expect(decodeJsonRpcMessage(1)).toEqual(parseError());
    expect(decodeJsonRpcMessage({ method: "thread/list" })).toEqual(parseError());
    expect(decodeJsonRpcMessage(["thread/list"])).toEqual(parseError());
  });

  test("maps malformed JSON text and bytes to parse errors", () => {
    expect(decodeJsonRpcMessage("{bad")).toEqual(parseError());
    expect(decodeJsonRpcMessage(new TextEncoder().encode("{bad"))).toEqual(parseError());
    expect(decodeJsonRpcMessage("")).toEqual(parseError());
  });

  test("preserves envelope ids on invalid request objects", () => {
    expect(decodeJsonRpcMessage(JSON.stringify({ id: "req-1", method: " " }))).toEqual({
      ok: false,
      response: {
        id: "req-1",
        error: {
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: "Invalid JSON-RPC-lite envelope",
        },
      },
    });
    expect(decodeJsonRpcMessage(JSON.stringify(["bad"]))).toEqual({
      ok: false,
      response: {
        id: null,
        error: {
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: "Expected object",
        },
      },
    });
  });
});
