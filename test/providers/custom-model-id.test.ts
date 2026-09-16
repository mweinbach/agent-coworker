import { describe, expect, test } from "bun:test";

import { normalizeCustomModelId } from "../../src/providers/customModels";

describe("normalizeCustomModelId", () => {
  test("trims a valid id and keeps the original characters", () => {
    expect(normalizeCustomModelId("  org/glm-5.2  ")).toBe("org/glm-5.2");
    expect(normalizeCustomModelId("a".repeat(2048))).toHaveLength(2048);
  });

  test("rejects blank, control-character, and overlong ids", () => {
    expect(() => normalizeCustomModelId("")).toThrow("model id is required.");
    expect(() => normalizeCustomModelId("   ")).toThrow("model id is required.");
    expect(() => normalizeCustomModelId("gpt\n5")).toThrow(
      "model id cannot contain control characters.",
    );
    expect(() => normalizeCustomModelId("gpt\u007f5")).toThrow(
      "model id cannot contain control characters.",
    );
    expect(() => normalizeCustomModelId(`x${"a".repeat(2048)}`)).toThrow(
      "model id must be 2048 characters or fewer.",
    );
  });

  test("uses the caller-supplied source name in error messages", () => {
    expect(() => normalizeCustomModelId(" ", "custom model")).toThrow("custom model is required.");
  });
});
