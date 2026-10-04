import { describe, expect, test } from "bun:test";

import { jsonRpcConnectorsRequestSchemas } from "../src/server/jsonrpc/schema.connectors";

const listSchema = jsonRpcConnectorsRequestSchemas["cowork/connectors/openai-native/list"];
const refreshSchema = jsonRpcConnectorsRequestSchemas["cowork/connectors/openai-native/refresh"];
const setEnabledSchema =
  jsonRpcConnectorsRequestSchemas["cowork/connectors/openai-native/setEnabled"];

describe("openai-native connector request schemas", () => {
  test("list and refresh accept optional cwd and reject a non-string cwd", () => {
    expect(listSchema.parse({})).toEqual({});
    expect(refreshSchema.parse({ cwd: "/tmp/project" })).toMatchObject({ cwd: "/tmp/project" });
    expect(listSchema.safeParse({ cwd: 12 }).success).toBe(false);
    expect(refreshSchema.safeParse({ cwd: null }).success).toBe(false);
  });

  test("setEnabled rejects blank connector ids and missing or non-boolean enabled", () => {
    expect(
      setEnabledSchema.parse({
        connectorId: " gmail ",
        enabled: true,
      }),
    ).toMatchObject({
      connectorId: "gmail",
      enabled: true,
    });

    expect(setEnabledSchema.safeParse({ connectorId: " ", enabled: true }).success).toBe(false);
    expect(setEnabledSchema.safeParse({ connectorId: "", enabled: false }).success).toBe(false);
    expect(setEnabledSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(setEnabledSchema.safeParse({ connectorId: "gmail" }).success).toBe(false);
    expect(setEnabledSchema.safeParse({ connectorId: "gmail", enabled: "yes" }).success).toBe(
      false,
    );
  });
});
