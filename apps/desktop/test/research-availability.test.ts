import { describe, expect, test } from "bun:test";

import { isResearchAvailable, resolveResearchAwareView } from "../src/app/researchAvailability";

describe("research availability", () => {
  test("requires Google to be connected", () => {
    expect(isResearchAvailable([])).toBe(false);
    expect(isResearchAvailable(["openai", "codex-cli"])).toBe(false);
    expect(isResearchAvailable(["google"])).toBe(true);
  });

  test("falls back from a stale Research view", () => {
    expect(resolveResearchAwareView("research", [])).toBe("chat");
    expect(resolveResearchAwareView("research", ["google"])).toBe("research");
    expect(resolveResearchAwareView("settings", [])).toBe("settings");
  });
});
