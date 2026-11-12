import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  listGoogleReasoningEffortValuesForModel,
  normalizeGoogleThinkingLevelForModel,
} from "../../src/shared/googleThinking";

describe("googleThinking helpers", () => {
  test("flash models expose dynamic plus minimal through high", () => {
    const flashReasoningEfforts = [
      GOOGLE_DYNAMIC_REASONING_EFFORT,
      "minimal",
      "low",
      "medium",
      "high",
    ];
    expect(listGoogleReasoningEffortValuesForModel("gemini-3-flash-preview")).toEqual([
      ...flashReasoningEfforts,
    ]);
    expect(listGoogleReasoningEffortValuesForModel("gemini-3.1-flash-lite")).toEqual([
      ...flashReasoningEfforts,
    ]);
    expect(listGoogleReasoningEffortValuesForModel("gemini-3.1-flash-lite-preview")).toEqual([
      ...flashReasoningEfforts,
    ]);
  });

  test("pro models omit minimal reasoning effort", () => {
    expect(listGoogleReasoningEffortValuesForModel("gemini-3.1-pro-preview")).toEqual([
      GOOGLE_DYNAMIC_REASONING_EFFORT,
      "low",
      "medium",
      "high",
    ]);
  });

  test("normalizes unsupported thinking levels away for the selected model", () => {
    expect(
      normalizeGoogleThinkingLevelForModel("gemini-3.1-pro-preview", "minimal"),
    ).toBeUndefined();
    expect(normalizeGoogleThinkingLevelForModel("gemini-3.1-pro-preview", "low")).toBe("low");
    expect(normalizeGoogleThinkingLevelForModel("gemini-3-flash-preview", "minimal")).toBe(
      "minimal",
    );
  });
});
