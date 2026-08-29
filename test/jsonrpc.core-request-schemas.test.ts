import { describe, expect, test } from "bun:test";

import {
  jsonRpcCoreRequestSchemas,
  jsonRpcCoreResultSchemas,
} from "../src/server/jsonrpc/schema.core";

describe("core handshake JSON-RPC schemas", () => {
  test("initialize trims client info and rejects extras or blank capability names", () => {
    expect(
      jsonRpcCoreRequestSchemas.initialize.parse({
        clientInfo: { name: "  desktop  ", title: "Cowork", version: "1.0.0" },
        capabilities: {
          experimentalApi: true,
          toolRetryLineage: true,
          optOutNotificationMethods: ["  cowork/log  "],
        },
      }),
    ).toEqual({
      clientInfo: { name: "desktop", title: "Cowork", version: "1.0.0" },
      capabilities: {
        experimentalApi: true,
        toolRetryLineage: true,
        optOutNotificationMethods: ["cowork/log"],
      },
    });

    expect(
      jsonRpcCoreRequestSchemas.initialize.safeParse({
        clientInfo: { name: "   " },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCoreRequestSchemas.initialize.safeParse({
        clientInfo: { name: "desktop", extra: true },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCoreRequestSchemas.initialize.safeParse({
        clientInfo: { name: "desktop" },
        capabilities: { extra: true },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCoreRequestSchemas.initialize.safeParse({
        clientInfo: { name: "desktop" },
        capabilities: { optOutNotificationMethods: ["   "] },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCoreRequestSchemas.initialize.safeParse({
        clientInfo: { name: "desktop" },
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("initialized accepts only an empty object", () => {
    expect(jsonRpcCoreRequestSchemas.initialized.parse({})).toEqual({});
    expect(jsonRpcCoreRequestSchemas.initialized.safeParse({ extra: true }).success).toBe(false);
  });

  test("initialize result is a strict transport and capability envelope", () => {
    const result = {
      protocolVersion: "2025-11-19",
      serverInfo: { name: "cowork", subprotocol: "jsonrpc" },
      capabilities: { experimentalApi: false },
      transport: { type: "websocket" as const, protocolMode: "jsonrpc" as const },
    };
    expect(jsonRpcCoreResultSchemas.initialize.parse(result)).toEqual(result);

    expect(
      jsonRpcCoreResultSchemas.initialize.safeParse({
        ...result,
        capabilities: {},
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCoreResultSchemas.initialize.safeParse({
        ...result,
        transport: { type: "unix", protocolMode: "jsonrpc" },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcCoreResultSchemas.initialize.safeParse({
        ...result,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
