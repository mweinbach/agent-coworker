import { describe, expect, test } from "bun:test";
import { redactCredentialText, redactSensitiveText } from "../src/diagnostics/sensitiveText";

describe("sensitiveText", () => {
  test("redacts private keys, auth headers, assignment secrets, and token shapes while keeping benign text", () => {
    const redacted = redactCredentialText(
      [
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
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

    for (const secret of [
      "MIIEowIBAAKCAQEA",
      "abcdefghijk",
      "dXNlcjpwYXNz",
      "sk-abcdefghijklmnopqrstuv",
      "hunter2-secret",
      "hunter2@example.com",
      "ghp_abcdefghijklmnopqrstuvwxyz12",
      "xoxb-123456789012345678-token",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyA-abcdefghijklmnopqrst",
      "eyJhbGciOiJIUzI1NiJ9",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    for (const marker of [
      "[redacted-secret]",
      "Bearer [redacted]",
      "Authorization: Basic [redacted]",
      "https://user:[redacted]@example.com/v1",
    ]) {
      expect(redacted).toContain(marker);
    }

    const benign = "read src/index.ts then run bun test with token=abc";
    expect(redactCredentialText(benign)).toBe(benign);
    expect(redactCredentialText("sk-short")).toBe("sk-short");
  });

  test("redactSensitiveText also redacts emails, prompt bodies, and JSON payloads", () => {
    expect(redactSensitiveText("ping max@example.com")).toBe("ping [redacted-email]");
    expect(redactSensitiveText("turn prompt=read the private file")).toBe("turn [redacted-body]");
    expect(redactSensitiveText('{"messages":[{"role":"user","content":"hello"}]}')).toBe(
      "[redacted-json-body]",
    );
    expect(redactSensitiveText('{"ok":true,"count":2}')).toBe('{"ok":true,"count":2}');
  });
});
