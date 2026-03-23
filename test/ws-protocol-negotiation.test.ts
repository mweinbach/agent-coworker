import { describe, expect, test } from "bun:test";

import {
  parseWsProtocolDefault,
  resolveWsProtocol,
  splitWebSocketSubprotocolHeader,
} from "../src/server/wsProtocol/negotiation";

describe("WebSocket protocol negotiation", () => {
  test("always returns jsonrpc regardless of input", () => {
    expect(parseWsProtocolDefault(undefined)).toBe("jsonrpc");
    expect(parseWsProtocolDefault(null)).toBe("jsonrpc");
    expect(parseWsProtocolDefault("weird")).toBe("jsonrpc");
    expect(parseWsProtocolDefault("jsonrpc")).toBe("jsonrpc");
    expect(parseWsProtocolDefault(" JSONRPC ")).toBe("jsonrpc");
  });

  test("splits websocket subprotocol header", () => {
    expect(splitWebSocketSubprotocolHeader("cowork.jsonrpc.v1, cowork.legacy.v1")).toEqual([
      "cowork.jsonrpc.v1",
      "cowork.legacy.v1",
    ]);
  });

  test("accepts jsonrpc subprotocol", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: ["cowork.jsonrpc.v1"],
      requestedProtocol: null,
      defaultProtocol: "jsonrpc",
    });
    expect(resolved).toEqual({
      ok: true,
      protocol: {
        mode: "jsonrpc",
        selectedSubprotocol: "cowork.jsonrpc.v1",
        source: "subprotocol",
      },
    });
  });

  test("selects jsonrpc from mixed subprotocol list", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: ["foo", "cowork.jsonrpc.v1"],
      requestedProtocol: null,
      defaultProtocol: "jsonrpc",
    });
    expect(resolved).toEqual({
      ok: true,
      protocol: {
        mode: "jsonrpc",
        selectedSubprotocol: "cowork.jsonrpc.v1",
        source: "subprotocol",
      },
    });
  });

  test("falls back to query param when no subprotocol is offered", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: [],
      requestedProtocol: "jsonrpc",
      defaultProtocol: "jsonrpc",
    });
    expect(resolved).toEqual({
      ok: true,
      protocol: {
        mode: "jsonrpc",
        selectedSubprotocol: null,
        source: "query",
      },
    });
  });

  test("falls back to server default when no explicit selection is provided", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: [],
      requestedProtocol: null,
      defaultProtocol: "jsonrpc",
    });
    expect(resolved).toEqual({
      ok: true,
      protocol: {
        mode: "jsonrpc",
        selectedSubprotocol: null,
        source: "default",
      },
    });
  });

  test("rejects unsupported subprotocols", () => {
    expect(resolveWsProtocol({
      offeredSubprotocols: ["unsupported.v1"],
      requestedProtocol: null,
      defaultProtocol: "jsonrpc",
    })).toEqual({
      ok: false,
      error: expect.stringContaining("Unsupported WebSocket subprotocol: unsupported.v1"),
    });
  });

  test("rejects legacy protocol via query param", () => {
    expect(resolveWsProtocol({
      offeredSubprotocols: [],
      requestedProtocol: "legacy",
      defaultProtocol: "jsonrpc",
    })).toEqual({
      ok: false,
      error: expect.stringContaining("Only \"jsonrpc\" is supported"),
    });
  });

  test("rejects unknown query param values", () => {
    expect(resolveWsProtocol({
      offeredSubprotocols: [],
      requestedProtocol: "weird",
      defaultProtocol: "jsonrpc",
    })).toEqual({
      ok: false,
      error: expect.stringContaining("Only \"jsonrpc\" is supported"),
    });
  });

  test("rejects legacy subprotocol", () => {
    expect(resolveWsProtocol({
      offeredSubprotocols: ["cowork.legacy.v1"],
      requestedProtocol: null,
      defaultProtocol: "jsonrpc",
    })).toEqual({
      ok: false,
      error: expect.stringContaining("Unsupported WebSocket subprotocol: cowork.legacy.v1"),
    });
  });
});
