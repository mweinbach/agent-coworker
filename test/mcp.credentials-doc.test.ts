import { describe, expect, test } from "bun:test";

import { normalizeCredentialsDoc } from "../src/mcp/authStore/parser";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

function validDoc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    updatedAt: UPDATED_AT,
    servers: {},
    ...overrides,
  };
}

describe("normalizeCredentialsDoc", () => {
  test("accepts a minimal v1 document and a populated api-key record", () => {
    expect(normalizeCredentialsDoc(validDoc())).toEqual({
      version: 1,
      updatedAt: UPDATED_AT,
      servers: {},
    });

    expect(
      normalizeCredentialsDoc(
        validDoc({
          servers: {
            docs: {
              apiKey: { value: "secret-key", updatedAt: UPDATED_AT },
            },
          },
        }),
      ),
    ).toMatchObject({
      servers: { docs: { apiKey: { value: "secret-key" } } },
    });
  });

  test("rejects extras, wrong versions, blank names, and invalid timestamps", () => {
    expect(() => normalizeCredentialsDoc(validDoc({ extra: true }))).toThrow(
      /Invalid credential store schema/,
    );
    expect(() => normalizeCredentialsDoc(validDoc({ version: 2 }))).toThrow(
      /Invalid credential store schema/,
    );
    expect(() => normalizeCredentialsDoc(validDoc({ servers: { "": {} } }))).toThrow(
      /Invalid credential store schema/,
    );
    expect(() => normalizeCredentialsDoc(validDoc({ updatedAt: "2026-01-01" }))).toThrow(
      /Invalid credential store schema/,
    );
    expect(() =>
      normalizeCredentialsDoc(
        validDoc({
          servers: {
            docs: {
              apiKey: { value: "secret-key", updatedAt: "not-a-date" },
            },
          },
        }),
      ),
    ).toThrow(/Invalid credential store schema/);
    expect(() =>
      normalizeCredentialsDoc(
        validDoc({
          servers: {
            docs: {
              oauth: { pending: { challengeId: "c1" }, extra: true },
            },
          },
        }),
      ),
    ).toThrow(/Invalid credential store schema/);
  });
});
