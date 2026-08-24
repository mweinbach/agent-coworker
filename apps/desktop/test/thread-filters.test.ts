import { describe, expect, test } from "bun:test";

import { isStandardChatThread } from "../src/app/threadFilters";

describe("isStandardChatThread", () => {
  test("hides agent sessions from normal chat lists", () => {
    expect(isStandardChatThread({ sessionKind: "agent" })).toBe(false);
    expect(isStandardChatThread({ sessionKind: "root" })).toBe(true);
  });
});
