import { describe, expect, test } from "bun:test";

import {
  parseWsProtocolDefault,
  resolveWsProtocol,
  splitWebSocketSubprotocolHeader,
} from "../src/server/wsProtocol/negotiation";

describe("WebSocket protocol negotiation", () => {
  test("defaults to legacy for unknown values", () => {
    expect(parseWsProtocolDefault(undefined)).toBe("legacy");
    expect(parseWsProtocolDefault(null)).toBe("legacy");
    expect(parseWsProtocolDefault("weird")).toBe("legacy");
  });

  test("parses explicit jsonrpc default", () => {
    expect(parseWsProtocolDefault("jsonrpc")).toBe("jsonrpc");
    expect(parseWsProtocolDefault(" JSONRPC ")).toBe("jsonrpc");
  });

  test("splits websocket subprotocol header", () => {
    expect(splitWebSocketSubprotocolHeader("cowork.jsonrpc.v1, cowork.legacy.v1")).toEqual([
      "cowork.jsonrpc.v1",
      "cowork.legacy.v1",
    ]);
  });

  test("prefers supported subprotocol over query/default", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: ["cowork.jsonrpc.v1"],
      requestedProtocol: "legacy",
      defaultProtocol: "legacy",
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

  test("selects the first supported subprotocol from an offered list", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: ["foo", "cowork.jsonrpc.v1", "cowork.legacy.v1"],
      requestedProtocol: "legacy",
      defaultProtocol: "legacy",
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
      defaultProtocol: "legacy",
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

  test("rejects unsupported subprotocols and query modes", () => {
    expect(resolveWsProtocol({
      offeredSubprotocols: ["unsupported.v1"],
      requestedProtocol: null,
      defaultProtocol: "legacy",
    })).toEqual({
      ok: false,
      error: "Unsupported WebSocket subprotocol: unsupported.v1",
    });

    expect(resolveWsProtocol({
      offeredSubprotocols: [],
      requestedProtocol: "weird",
      defaultProtocol: "legacy",
    })).toEqual({
      ok: false,
      error: "Unsupported WebSocket protocol mode: weird",
    });
  });

  test("rejects when no offered subprotocol is supported", () => {
    expect(resolveWsProtocol({
      offeredSubprotocols: ["foo", "bar"],
      requestedProtocol: "jsonrpc",
      defaultProtocol: "legacy",
    })).toEqual({
      ok: false,
      error: "Unsupported WebSocket subprotocol: foo",
    });
  });
});
