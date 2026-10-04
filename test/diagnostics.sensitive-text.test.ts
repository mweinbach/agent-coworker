import { describe, expect, test } from "bun:test";

import { redactCredentialText, redactSensitiveText } from "../src/diagnostics/sensitiveText";

describe("redactCredentialText", () => {
  test("redacts private keys, auth headers, assignment secrets, and token shapes", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactCredentialText(
      [
        pem,
        "Bearer abcdefghijk",
        "Authorization: Basic dXNlcjpwYXNz",
        "api_key=sk-abcdefghijklmnopqrstuv",
        "password: hunter2-secret",
        "https://user:hunter2@example.com/v1",
        "ghp_abcdefghijklmnopqrstuvwxyz12",
        "xoxb-123456789012345678-token",
        "AKIAIOSFODNN7EXAMPLE",
        "AIzaSyA-abcdefghijklmnopqrst",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature123",
      ].join("\n"),
    );

    expect(redacted).not.toContain("MIIEowIBAAKCAQEA");
    expect(redacted).not.toContain("abcdefghijk");
    expect(redacted).not.toContain("dXNlcjpwYXNz");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(redacted).not.toContain("hunter2-secret");
    expect(redacted).not.toContain("hunter2@example.com");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz12");
    expect(redacted).not.toContain("xoxb-123456789012345678-token");
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).not.toContain("AIzaSyA-abcdefghijklmnopqrst");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).toContain("[redacted-secret]");
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).toContain("Authorization: Basic [redacted]");
    expect(redacted).toContain("https://user:[redacted]@example.com/v1");
  });

  test("leaves short tokens and ordinary paths unchanged", () => {
    const benign = "read src/index.ts then run bun test with token=abc";
    expect(redactCredentialText(benign)).toBe(benign);
    expect(redactCredentialText("sk-short")).toBe("sk-short");
  });
});

describe("redactSensitiveText", () => {
  test("also redacts emails, prompt bodies, and JSON payloads", () => {
    expect(redactSensitiveText("ping max@example.com")).toBe("ping [redacted-email]");
    expect(redactSensitiveText("turn prompt=read the private file")).toBe("turn [redacted-body]");
    expect(redactSensitiveText('{"messages":[{"role":"user","content":"hello"}]}')).toBe(
      "[redacted-json-body]",
    );
  });

  test("does not treat short JSON without secret keys as a body", () => {
    expect(redactSensitiveText('{"ok":true,"count":2}')).toBe('{"ok":true,"count":2}');
  });
});
