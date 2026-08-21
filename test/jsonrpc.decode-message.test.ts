import { describe, expect, test } from "bun:test";

import { decodeJsonRpcMessage } from "../src/server/jsonrpc/decodeJsonRpcMessage";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";

const validRequest = {
  id: 7,
  method: "thread/list",
  params: { cwd: "/workspace/project" },
};

describe("decodeJsonRpcMessage", () => {
  test("accepts string, Uint8Array, and ArrayBuffer frames", () => {
    const text = JSON.stringify(validRequest);
    const bytes = new TextEncoder().encode(text);

    expect(decodeJsonRpcMessage(text)).toEqual({
      ok: true,
      message: validRequest,
    });
    expect(decodeJsonRpcMessage(bytes)).toEqual({
      ok: true,
      message: validRequest,
    });
    expect(
      decodeJsonRpcMessage(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ),
    ).toEqual({
      ok: true,
      message: validRequest,
    });
  });

  test("rejects non-frame values as Invalid JSON before parsing", () => {
    for (const raw of [null, 12, { method: "thread/list" }, ["thread/list"]]) {
      expect(decodeJsonRpcMessage(raw)).toEqual({
        ok: false,
        response: {
          id: null,
          error: {
            code: JSONRPC_ERROR_CODES.parseError,
            message: "Invalid JSON",
          },
        },
      });
    }
  });

  test("keeps parse errors from malformed text and binary payloads", () => {
    expect(decodeJsonRpcMessage("{bad")).toEqual({
      ok: false,
      response: {
        id: null,
        error: {
          code: JSONRPC_ERROR_CODES.parseError,
          message: "Invalid JSON",
        },
      },
    });
    expect(decodeJsonRpcMessage(new TextEncoder().encode("{bad"))).toEqual({
      ok: false,
      response: {
        id: null,
        error: {
          code: JSONRPC_ERROR_CODES.parseError,
          message: "Invalid JSON",
        },
      },
    });
    expect(decodeJsonRpcMessage(JSON.stringify(["not-an-object"]))).toEqual({
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
