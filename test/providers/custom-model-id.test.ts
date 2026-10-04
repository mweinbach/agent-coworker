import { describe, expect, test } from "bun:test";
import { normalizeCustomModelId } from "../../src/providers/customModels";

describe("normalizeCustomModelId", () => {
  test("trims a valid id, preserves characters, and rejects invalid inputs", () => {
    expect(normalizeCustomModelId("  org/glm-5.2  ")).toBe("org/glm-5.2");
    expect(normalizeCustomModelId("a".repeat(2048))).toHaveLength(2048);

    for (const [id, source, expected] of [
      ["", undefined, "model id is required."],
      ["   ", undefined, "model id is required."],
      [" ", "custom model", "custom model is required."],
      ["gpt\n5", undefined, "model id cannot contain control characters."],
      ["gpt\u007f5", undefined, "model id cannot contain control characters."],
      [`x${"a".repeat(2048)}`, undefined, "model id must be 2048 characters or fewer."],
    ] as const) {
      expect(() => normalizeCustomModelId(id, source)).toThrow(expected);
    }
  });
});
