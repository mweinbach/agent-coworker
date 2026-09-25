import { describe, expect, test } from "bun:test";

import { normalizeAgentTargetPaths } from "../../src/shared/agents";

describe("normalizeAgentTargetPaths", () => {
  test("treats missing paths as unset and empty lists as empty", () => {
    expect(normalizeAgentTargetPaths(undefined)).toBeUndefined();
    expect(normalizeAgentTargetPaths(null)).toBeUndefined();
    expect(normalizeAgentTargetPaths([])).toEqual([]);
  });

  test("trims entries and keeps first-seen order when deduping", () => {
    expect(
      normalizeAgentTargetPaths(["  src/  ", "docs", "src/", "docs", " test/helpers "]),
    ).toEqual(["src/", "docs", "test/helpers"]);
  });

  test("fails closed on blank entries instead of dropping them", () => {
    expect(() => normalizeAgentTargetPaths(["src", "   "])).toThrow(
      "targetPaths entries must not be empty",
    );
    expect(() => normalizeAgentTargetPaths([""])).toThrow("targetPaths entries must not be empty");
  });
});
