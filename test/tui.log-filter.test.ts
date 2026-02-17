import { describe, expect, test } from "bun:test";

import { shouldSuppressLegacyToolLogLine, shouldSuppressRawDebugLogLine } from "../apps/TUI/context/sync";

describe("TUI log suppression helpers", () => {
  test("suppresses raw provider debug stream logs", () => {
    expect(shouldSuppressRawDebugLogLine("raw stream part: {\"type\":\"response.function_call_arguments.delta\"}")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("{\"type\":\"response.reasoning_summary_text.delta\"}")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("\"obfuscation\":\"abc\"")).toBe(true);
  });

  test("keeps normal tool logs", () => {
    expect(shouldSuppressRawDebugLogLine("tool> read {\"path\":\"README.md\"}")).toBe(false);
  });

  test("suppresses legacy tool logs only when model stream is active", () => {
    const toolStart = "tool> read {\"path\":\"README.md\"}";
    const toolDone = "tool< read {\"chars\":42}";
    const normalLog = "[info] finished";

    expect(shouldSuppressLegacyToolLogLine(toolStart, false)).toBe(false);
    expect(shouldSuppressLegacyToolLogLine(toolDone, false)).toBe(false);
    expect(shouldSuppressLegacyToolLogLine(normalLog, false)).toBe(false);

    expect(shouldSuppressLegacyToolLogLine(toolStart, true)).toBe(true);
    expect(shouldSuppressLegacyToolLogLine(toolDone, true)).toBe(true);
    expect(shouldSuppressLegacyToolLogLine(normalLog, true)).toBe(false);
  });
});
