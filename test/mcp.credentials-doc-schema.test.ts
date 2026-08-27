import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MCP_CREDENTIALS_DOCUMENT,
  normalizeCredentialsDoc,
} from "../src/mcp/authStore/parser";

const UPDATED_AT = "2026-08-27T10:00:00.000Z";

describe("MCP credential document schema", () => {
  test("accepts the default document and a complete server record", () => {
    expect(normalizeCredentialsDoc(DEFAULT_MCP_CREDENTIALS_DOCUMENT)).toEqual(
      DEFAULT_MCP_CREDENTIALS_DOCUMENT,
    );
    expect(
      normalizeCredentialsDoc({
        version: 1,
        updatedAt: UPDATED_AT,
        servers: {
          "local-search": {
            apiKey: { value: "not-a-real-key", updatedAt: UPDATED_AT },
            oauth: {
              tokens: {
                accessToken: "not-a-real-access-token",
                updatedAt: UPDATED_AT,
                tokenType: "Bearer",
              },
              clientInformation: {
                clientId: "client-1",
                tokenEndpointAuthMethod: "none",
                updatedAt: UPDATED_AT,
              },
            },
          },
        },
      }),
    ).toMatchObject({
      version: 1,
      servers: {
        "local-search": {
          apiKey: { value: "not-a-real-key" },
          oauth: { tokens: { accessToken: "not-a-real-access-token" } },
        },
      },
    });
  });

  test("fails closed on extra fields, unknown versions, and bad timestamps", () => {
    const valid = {
      version: 1,
      updatedAt: UPDATED_AT,
      servers: {},
    };
    expect(() => normalizeCredentialsDoc({ ...valid, extra: true })).toThrow(
      /Invalid credential store schema/,
    );
    expect(() => normalizeCredentialsDoc({ ...valid, version: 2 })).toThrow(
      /Invalid credential store schema/,
    );
    expect(() =>
      normalizeCredentialsDoc({
        ...valid,
        updatedAt: "2026-08-27T10:00:00.000",
      }),
    ).toThrow(/Invalid credential store schema/);
    expect(() =>
      normalizeCredentialsDoc({
        ...valid,
        servers: {
          search: {
            oauth: {
              tokens: { accessToken: "tok", updatedAt: UPDATED_AT },
              extraOauth: true,
            },
          },
        },
      }),
    ).toThrow(/Invalid credential store schema/);
  });

  test("fails closed on blank ids, empty server keys, and blank secrets", () => {
    expect(() =>
      normalizeCredentialsDoc({
        version: 1,
        updatedAt: UPDATED_AT,
        servers: { "": { apiKey: { value: "x", updatedAt: UPDATED_AT } } },
      }),
    ).toThrow(/Invalid credential store schema/);
    expect(() =>
      normalizeCredentialsDoc({
        version: 1,
        updatedAt: UPDATED_AT,
        servers: {
          search: { apiKey: { value: "   ", updatedAt: UPDATED_AT } },
        },
      }),
    ).toThrow(/Invalid credential store schema/);
    expect(() =>
      normalizeCredentialsDoc({
        version: 1,
        updatedAt: UPDATED_AT,
        servers: {
          search: {
            oauth: {
              tokens: { accessToken: "", updatedAt: UPDATED_AT },
            },
          },
        },
      }),
    ).toThrow(/Invalid credential store schema/);
    expect(() => normalizeCredentialsDoc(null)).toThrow(/Invalid credential store schema/);
    expect(() => normalizeCredentialsDoc([])).toThrow(/Invalid credential store schema/);
  });
});
