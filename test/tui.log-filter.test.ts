import { describe, expect, test } from "bun:test";

import { shouldSuppressRawDebugLogLine } from "../apps/TUI/context/sync";

describe("TUI log suppression helpers", () => {
  test("suppresses raw provider debug stream logs", () => {
    expect(shouldSuppressRawDebugLogLine("raw stream part: {\"type\":\"response.function_call_arguments.delta\"}")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("{\"type\":\"response.reasoning_summary_text.delta\"}")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("\"obfuscation\":\"abc\"")).toBe(true);
  });

  test("keeps normal tool logs", () => {
    expect(shouldSuppressRawDebugLogLine("tool> read {\"path\":\"README.md\"}")).toBe(false);
  });
});
