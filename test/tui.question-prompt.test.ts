import { describe, expect, test } from "bun:test";

import {
  normalizeAskOptions,
  normalizeAskQuestion,
  shouldRenderAskOptions,
} from "../apps/TUI/routes/session/question";

describe("TUI question prompt helpers", () => {
  test("normalizes and truncates long question text", () => {
    const question = "  What   should\n\nwe do next?   ";
    expect(normalizeAskQuestion(question)).toBe("What should we do next?");
  });

  test("filters raw-like options and keeps readable options", () => {
    const options = normalizeAskOptions([
      "{\"type\":\"response.completed\"}",
      "  Keep this option  ",
      "obfuscation: abc123",
      "AddnmoreiDCFtfeaturesrnetbdebt,oshares,eequityevaluexperyshare,tsensitivity(table)ended",
      "Keep this option",
      "Second option",
    ]);
    expect(options).toEqual(["Keep this option", "Second option"]);
  });

  test("strips embedded raw-stream tails from question text", () => {
    expect(normalizeAskQuestion("question: Should we ship?\nraw stream part: {\"type\":\"response.completed\"}")).toBe("Should we ship?");
  });

  test("renders option mode only when 2+ readable options are present", () => {
    expect(shouldRenderAskOptions([])).toBe(false);
    expect(shouldRenderAskOptions(["Only one"])).toBe(false);
    expect(shouldRenderAskOptions(["A", "B"])).toBe(true);
  });
});
