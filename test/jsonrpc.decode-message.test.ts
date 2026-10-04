import { describe, expect, test } from "bun:test";
import { decodeJsonRpcMessage } from "../src/server/jsonrpc/decodeJsonRpcMessage";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";

const request = { id: 7, method: "thread/list", params: { cwd: "/workspace" } };
const encoded = JSON.stringify(request);
const parseError = (message = "Invalid JSON") => ({
  ok: false as const,
  response: { id: null, error: { code: JSONRPC_ERROR_CODES.parseError, message } },
});

describe("decodeJsonRpcMessage", () => {
  test("accepts string, Uint8Array, and ArrayBuffer frames", () => {
    const bytes = new TextEncoder().encode(encoded);
    for (const frame of [
      encoded,
      bytes,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      Buffer.from(encoded),
    ]) {
      expect(decodeJsonRpcMessage(frame)).toEqual({ ok: true, message: request });
    }
  });

  test("rejects non-frame payloads and malformed JSON as parse errors", () => {
    for (const bad of [
      null,
      1,
      { method: "thread/list" },
      ["thread/list"],
      "{bad",
      new TextEncoder().encode("{bad"),
      "",
    ]) {
      expect(decodeJsonRpcMessage(bad)).toEqual(parseError());
    }
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
        error: { code: JSONRPC_ERROR_CODES.invalidRequest, message: "Expected object" },
      },
    });
  });
});
