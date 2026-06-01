import { describe, expect, test } from "bun:test";

import { redactDiagnosticText, sanitizeLogMeta } from "../src/diagnostics/redaction";

describe("diagnostics redaction", () => {
  test("redacts home and workspace paths from strings", () => {
    const text = "failed in /Users/alice/project/src/index.ts and /Users/alice/.cowork/auth.json";
    const redacted = redactDiagnosticText(text, {
      homeDir: "/Users/alice",
      workspacePaths: ["/Users/alice/project"],
    });

    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).not.toContain("project/src/index.ts");
    expect(redacted).toContain("[workspace-path]");
    expect(redacted).toContain("[home]");
  });

  test("redacts secret-looking keys and token values", () => {
    const redacted = sanitizeLogMeta(
      {
        accessToken: "abc123456789",
        nested: {
          api_key: "sk-supersecretvalue123",
          safe: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        },
      },
      { homeDir: "/Users/alice" },
    );

    expect(JSON.stringify(redacted)).not.toContain("abc123456789");
    expect(JSON.stringify(redacted)).not.toContain("sk-supersecretvalue123");
    expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toMatchObject({
      accessToken: "[redacted]",
      nested: {
        api_key: "[redacted]",
        safe: expect.stringContaining("[redacted]"),
      },
    });
  });

  test("redacts emails, long strings, and body-like JSON payloads", () => {
    const longString = "x".repeat(1200);
    const redacted = sanitizeLogMeta(
      {
        email: "max@example.com",
        body: { prompt: "please read secret file", completion: "done" },
        longString,
        json: '{"messages":[{"role":"user","content":"hello"}]}',
      },
      { maxStringLength: 64 },
    );
    const rendered = JSON.stringify(redacted);

    expect(rendered).not.toContain("max@example.com");
    expect(rendered).not.toContain("please read secret file");
    expect(rendered).not.toContain("hello");
    expect(rendered).toContain("[redacted-email]");
    expect(rendered).toContain("[redacted-body]");
    expect(rendered).toContain("[redacted-long-string:1200]");
    expect(rendered).toContain("[redacted-json-body]");
  });

  test("redacts body-like assignment fields from legacy log lines", () => {
    const redacted = redactDiagnosticText(
      [
        "server exited code=1 stderr=private stack with /Users/alice/project/file.ts",
        "tool finished stdout=private shell output token=secret-token-value",
        "turn prompt=read a private file completion=done",
      ].join("\n"),
      {
        homeDir: "/Users/alice",
        workspacePaths: ["/Users/alice/project"],
      },
    );

    expect(redacted).not.toContain("private stack");
    expect(redacted).not.toContain("private shell output");
    expect(redacted).not.toContain("read a private file");
    expect(redacted).not.toContain("completion=done");
    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).toContain("[redacted-body]");
  });
});
