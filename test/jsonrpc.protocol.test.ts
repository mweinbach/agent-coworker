import { describe, expect, test } from "bun:test";

import {
  JSONRPC_ERROR_CODES,
  buildJsonRpcErrorResponse,
  buildJsonRpcResultResponse,
  parseInitializeParams,
  parseInitializedParams,
  parseJsonRpcClientMessage,
} from "../src/server/jsonrpc/protocol";

describe("JSON-RPC-lite protocol parsing", () => {
  test("parses valid requests and notifications", () => {
    const request = parseJsonRpcClientMessage(JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "desktop",
        },
      },
    }));
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.message).toEqual({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "desktop",
          },
        },
      });
    }

    const notification = parseJsonRpcClientMessage(JSON.stringify({
      method: "initialized",
    }));
    expect(notification.ok).toBe(true);
    if (notification.ok) {
      expect(notification.message).toEqual({
        method: "initialized",
      });
    }
  });

  test("rejects malformed envelopes", () => {
    expect(parseJsonRpcClientMessage("{bad")).toEqual({
      ok: false,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.parseError,
        message: "Invalid JSON",
      },
    });

    expect(parseJsonRpcClientMessage(JSON.stringify(["bad"]))).toEqual({
      ok: false,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: "Expected object",
      },
    });
  });

  test("validates initialize params", () => {
    expect(parseInitializeParams({
      clientInfo: {
        name: "desktop",
        title: "Desktop App",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["thread/started"],
      },
    })).toEqual({
      ok: true,
      params: {
        clientInfo: {
          name: "desktop",
          title: "Desktop App",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["thread/started"],
        },
      },
    });

    const invalid = parseInitializeParams({
      clientInfo: {
        name: "",
      },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
    }
  });

  test("normalizes initialized params", () => {
    expect(parseInitializedParams(undefined)).toEqual({
      ok: true,
      params: {},
    });
    expect(parseInitializedParams({})).toEqual({
      ok: true,
      params: {},
    });
  });

  test("builds result and error responses", () => {
    expect(buildJsonRpcResultResponse(1, { ok: true })).toEqual({
      id: 1,
      result: { ok: true },
    });
    expect(buildJsonRpcErrorResponse(1, { code: -1, message: "boom" })).toEqual({
      id: 1,
      error: { code: -1, message: "boom" },
    });
  });
});
