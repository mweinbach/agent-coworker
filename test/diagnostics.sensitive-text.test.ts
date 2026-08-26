import { describe, expect, test } from "bun:test";

import { redactSensitiveText } from "../src/diagnostics/sensitiveText";

describe("redactSensitiveText", () => {
  test("redacts PEM private keys", () => {
    const redacted = redactSensitiveText(
      "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----\nafter",
    );

    expect(redacted).toBe("before\n[redacted-secret]\nafter");
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA");
    expect(redacted).not.toContain("PRIVATE KEY");
  });

  test("redacts bearer and basic credentials in free text", () => {
    const headerLine = redactSensitiveText("Authorization: Bearer abcdefghijklmnop leftover");
    const freeText = redactSensitiveText(
      "proxy used Bearer abcdefghijklmnop and Basic dXNlcjpwYXNzd29yZA==",
    );

    expect(headerLine).toContain("Authorization=[redacted]");
    expect(headerLine).not.toContain("abcdefghijklmnop");
    expect(freeText).toBe("proxy used Bearer [redacted] and Basic [redacted]");
    expect(freeText).not.toContain("abcdefghijklmnop");
    expect(freeText).not.toContain("dXNlcjpwYXNzd29yZA==");
  });

  test("redacts assignment-style secrets", () => {
    const redacted = redactSensitiveText('api_key="not-a-real-api-key-value" password=hunter22');

    expect(redacted).toContain("api_key=[redacted]");
    expect(redacted).toContain("password=[redacted]");
    expect(redacted).not.toContain("not-a-real-api-key-value");
    expect(redacted).not.toContain("hunter22");
  });

  test("redacts credential URLs without dropping the scheme or user", () => {
    const redacted = redactSensitiveText(
      "clone https://oauth2:not-a-real-password@github.com/org/repo.git",
    );

    expect(redacted).toBe("clone https://oauth2:[redacted]@github.com/org/repo.git");
    expect(redacted).not.toContain("not-a-real-password");
  });

  test("redacts common secret value shapes in free text", () => {
    const redacted = redactSensitiveText(
      [
        "openai sk-notarealopenaikey00",
        "github ghp_notarealgithubpat0",
        "slack xoxb-notarealslacktokenvalue",
        "aws AKIAFAKESECRETKEY000",
        "google AIzaSyFakeGoogleApiKey000",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturevalue",
      ].join(" "),
    );

    expect(redacted).not.toContain("sk-notarealopenaikey00");
    expect(redacted).not.toContain("ghp_notarealgithubpat0");
    expect(redacted).not.toContain("xoxb-notarealslacktokenvalue");
    expect(redacted).not.toContain("AKIAFAKESECRETKEY000");
    expect(redacted).not.toContain("AIzaSyFakeGoogleApiKey000");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted.match(/\[redacted-secret\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  test("redacts emails and body-like assignment lines", () => {
    const redacted = redactSensitiveText(
      "contact max@example.com\nprompt: please read /etc/passwd\nstdout: dumped secrets",
    );

    expect(redacted).toContain("[redacted-email]");
    expect(redacted).toContain("[redacted-body]");
    expect(redacted).not.toContain("max@example.com");
    expect(redacted).not.toContain("/etc/passwd");
    expect(redacted).not.toContain("dumped secrets");
  });

  test("collapses JSON bodies that still look like prompt or secret payloads", () => {
    const redacted = redactSensitiveText(
      '{"prompt":"please summarize this transcript","messages":[{"role":"user","content":"hello"}]}',
    );

    expect(redacted).toBe("[redacted-json-body]");
    expect(redacted).not.toContain("please summarize");
    expect(redacted).not.toContain("hello");
  });

  test("keeps ordinary log lines that are not secret-shaped", () => {
    expect(redactSensitiveText("turn completed in 12ms")).toBe("turn completed in 12ms");
  });
});
