import { describe, expect, test } from "bun:test";
import { normalizeCredentialsDoc } from "../src/mcp/authStore/parser";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
const validDoc = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  updatedAt: UPDATED_AT,
  servers: {},
  ...overrides,
});

describe("normalizeCredentialsDoc", () => {
  test("accepts minimal and populated v1 documents and rejects invalid schemas", () => {
    expect(normalizeCredentialsDoc(validDoc())).toEqual({
      version: 1,
      updatedAt: UPDATED_AT,
      servers: {},
    });
    expect(
      normalizeCredentialsDoc(
        validDoc({ servers: { docs: { apiKey: { value: "secret-key", updatedAt: UPDATED_AT } } } }),
      ),
    ).toMatchObject({ servers: { docs: { apiKey: { value: "secret-key" } } } });

    for (const invalid of [
      { extra: true },
      { version: 2 },
      { servers: { "": {} } },
      { updatedAt: "2026-01-01" },
      { servers: { docs: { apiKey: { value: "secret-key", updatedAt: "not-a-date" } } } },
      { servers: { docs: { oauth: { pending: { challengeId: "c1" }, extra: true } } } },
    ]) {
      expect(() => normalizeCredentialsDoc(validDoc(invalid))).toThrow(
        /Invalid credential store schema/,
      );
    }
  });

  test("trims credential secrets and rejects a document that contains a blank one", () => {
    expect(
      normalizeCredentialsDoc(
        validDoc({
          servers: {
            docs: {
              apiKey: { value: "  secret-key  ", updatedAt: UPDATED_AT },
              oauth: {
                tokens: {
                  accessToken: " access-token ",
                  tokenType: " DPoP ",
                  refreshToken: " refresh-token ",
                  scope: " mcp ",
                  updatedAt: UPDATED_AT,
                },
              },
            },
          },
        }),
      ),
    ).toEqual({
      version: 1,
      updatedAt: UPDATED_AT,
      servers: {
        docs: {
          apiKey: { value: "secret-key", updatedAt: UPDATED_AT },
          oauth: {
            tokens: {
              accessToken: "access-token",
              tokenType: "DPoP",
              refreshToken: "refresh-token",
              scope: "mcp",
              updatedAt: UPDATED_AT,
            },
          },
        },
      },
    });

    for (const servers of [
      { docs: { apiKey: { value: "   ", updatedAt: UPDATED_AT } } },
      { docs: { oauth: { tokens: { accessToken: "   ", updatedAt: UPDATED_AT } } } },
      {
        kept: { apiKey: { value: "sibling-secret", updatedAt: UPDATED_AT } },
        docs: {
          oauth: {
            tokens: {
              accessToken: "access-token",
              refreshToken: "   ",
              updatedAt: UPDATED_AT,
            },
          },
        },
      },
      {
        docs: {
          oauth: {
            tokens: { accessToken: "access-token", tokenType: "   ", updatedAt: UPDATED_AT },
          },
        },
      },
      {
        docs: {
          oauth: {
            pending: {
              challengeId: "   ",
              state: "state",
              codeVerifier: "verifier",
              redirectUri: "http://127.0.0.1/callback",
              createdAt: UPDATED_AT,
              expiresAt: UPDATED_AT,
            },
          },
        },
      },
    ]) {
      expect(() => normalizeCredentialsDoc(validDoc({ servers }))).toThrow(
        /Invalid credential store schema/,
      );
    }
  });
});
