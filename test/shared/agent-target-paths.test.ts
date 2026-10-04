import { describe, expect, test } from "bun:test";
import { normalizeAgentTargetPaths } from "../../src/shared/agents";

describe("normalizeAgentTargetPaths", () => {
  test("normalizes unset, empty, and duplicate paths and rejects blank entries", () => {
    expect(normalizeAgentTargetPaths(undefined)).toBeUndefined();
    expect(normalizeAgentTargetPaths(null)).toBeUndefined();
    expect(normalizeAgentTargetPaths([])).toEqual([]);
    expect(
      normalizeAgentTargetPaths(["  src/  ", "docs", "src/", "docs", " test/helpers "]),
    ).toEqual(["src/", "docs", "test/helpers"]);
    for (const bad of [["src", "   "], [""]]) {
      expect(() => normalizeAgentTargetPaths(bad)).toThrow("targetPaths entries must not be empty");
    }
  });
});
