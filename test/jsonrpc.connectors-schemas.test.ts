import { describe, expect, test } from "bun:test";

import {
  jsonRpcConnectorsRequestSchemas,
  jsonRpcConnectorsResultSchemas,
} from "../src/server/jsonrpc/schema.connectors";

function connectorEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "openai_native_connectors",
    sessionId: "session-1",
    connectors: [
      {
        id: "gmail",
        name: "Gmail",
        isEnabled: true,
      },
    ],
    enabledConnectorIds: ["gmail"],
    authenticated: true,
    ...overrides,
  };
}

describe("OpenAI native connector JSON-RPC schemas", () => {
  test("setEnabled rejects blank connector ids and missing enabled", () => {
    expect(
      jsonRpcConnectorsRequestSchemas["cowork/connectors/openai-native/setEnabled"].parse({
        connectorId: "  gmail  ",
        enabled: false,
      }),
    ).toMatchObject({
      connectorId: "gmail",
      enabled: false,
    });
    expect(
      jsonRpcConnectorsRequestSchemas["cowork/connectors/openai-native/setEnabled"].safeParse({
        connectorId: "   ",
        enabled: true,
      }).success,
    ).toBe(false);
    expect(
      jsonRpcConnectorsRequestSchemas["cowork/connectors/openai-native/setEnabled"].safeParse({
        connectorId: "gmail",
      }).success,
    ).toBe(false);
    expect(
      jsonRpcConnectorsRequestSchemas["cowork/connectors/openai-native/list"].parse({}),
    ).toEqual({});
  });

  test("result events reject blank ids and extra envelope keys", () => {
    expect(
      jsonRpcConnectorsResultSchemas["cowork/connectors/openai-native/list"].parse({
        event: connectorEvent({
          connectors: [
            {
              id: "gmail",
              name: "Gmail",
              isEnabled: false,
              labels: { category: "mail" },
            },
          ],
        }),
      }).event.connectors[0],
    ).toMatchObject({
      id: "gmail",
      labels: { category: "mail" },
    });

    expect(
      jsonRpcConnectorsResultSchemas["cowork/connectors/openai-native/refresh"].safeParse({
        event: connectorEvent({ sessionId: "   " }),
      }).success,
    ).toBe(false);
    expect(
      jsonRpcConnectorsResultSchemas["cowork/connectors/openai-native/setEnabled"].safeParse({
        event: connectorEvent({
          connectors: [{ id: "gmail", name: "Gmail" }],
        }),
      }).success,
    ).toBe(false);
    expect(
      jsonRpcConnectorsResultSchemas["cowork/connectors/openai-native/list"].safeParse({
        event: connectorEvent({ extra: true }),
      }).success,
    ).toBe(false);
    expect(
      jsonRpcConnectorsResultSchemas["cowork/connectors/openai-native/list"].safeParse({
        event: connectorEvent(),
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      jsonRpcConnectorsResultSchemas["cowork/connectors/openai-native/list"].safeParse({
        event: connectorEvent({
          connectors: [{ id: "   ", name: "Gmail", isEnabled: true }],
        }),
      }).success,
    ).toBe(false);
  });
});
