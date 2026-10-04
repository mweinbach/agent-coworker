import { describe, expect, test } from "bun:test";
import { redactCredentialFields } from "../src/diagnostics/credentials";

describe("redactCredentialFields", () => {
  test("redacts secret keys, secret-looking values, and circular references", () => {
    expect(
      redactCredentialFields({
        api_key: "sk-supersecretvalue123",
        token: "abc123456789",
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        cookie: "sid=1",
        credential: "hidden",
        private_key: "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
        "private-key": "still-secret",
        password: "hunter2",
        note: "Bearer abcdefghijklmnopqrstuvwxyz",
        nested: {
          API_KEY: "nested-secret",
          safe: "visible",
          list: [{ secret: "inner", note: "ok" }],
        },
        count: 3,
        enabled: true,
        empty: null,
      }),
    ).toEqual({
      api_key: "[REDACTED]",
      token: "[REDACTED]",
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      credential: "[REDACTED]",
      private_key: "[REDACTED]",
      "private-key": "[REDACTED]",
      password: "[REDACTED]",
      note: "Bearer [redacted]",
      nested: {
        API_KEY: "[REDACTED]",
        safe: "visible",
        list: [{ secret: "[REDACTED]", note: "ok" }],
      },
      count: 3,
      enabled: true,
      empty: null,
    });

    const payload: { token: string; self?: unknown } = { token: "abc123456789" };
    payload.self = payload;
    expect(redactCredentialFields(payload)).toEqual({
      token: "[REDACTED]",
      self: "[Circular]",
    });
  });
});
