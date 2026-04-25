import { describe, expect, test } from "bun:test";

import { resolveWsProtocol, splitWebSocketSubprotocolHeader } from "../src/server/wsProtocol/negotiation";

describe("WebSocket protocol negotiation", () => {
  test("splits websocket subprotocol header", () => {
    expect(splitWebSocketSubprotocolHeader("cowork.jsonrpc.v1, unsupported.v1")).toEqual([
      "cowork.jsonrpc.v1",
      "unsupported.v1",
    ]);
  });

  test("accepts jsonrpc subprotocol", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: ["cowork.jsonrpc.v1"],
    });
    expect(resolved).toEqual({
      ok: true,
      protocol: {
        mode: "jsonrpc",
        selectedSubprotocol: "cowork.jsonrpc.v1",
      },
    });
  });

  test("selects jsonrpc from mixed subprotocol list", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: ["foo", "cowork.jsonrpc.v1"],
    });
    expect(resolved).toEqual({
      ok: true,
      protocol: {
        mode: "jsonrpc",
        selectedSubprotocol: "cowork.jsonrpc.v1",
      },
    });
  });

  test("uses implicit jsonrpc when no subprotocol is offered", () => {
    const resolved = resolveWsProtocol({
      offeredSubprotocols: [],
    });
    expect(resolved).toEqual({
      ok: true,
      protocol: {
        mode: "jsonrpc",
        selectedSubprotocol: null,
      },
    });
  });

  test("rejects unsupported subprotocols", () => {
    expect(
      resolveWsProtocol({
        offeredSubprotocols: ["unsupported.v1"],
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("Unsupported WebSocket subprotocol: unsupported.v1"),
    });
  });

  test("rejects non-jsonrpc subprotocols", () => {
    expect(
      resolveWsProtocol({
        offeredSubprotocols: ["cowork.example.v1"],
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("Unsupported WebSocket subprotocol: cowork.example.v1"),
    });
  });
});
