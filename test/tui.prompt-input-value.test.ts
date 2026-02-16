import { describe, expect, test } from "bun:test";

import { resolveTextareaInputValue } from "../apps/TUI/component/prompt/input-value";

describe("resolveTextareaInputValue", () => {
  test("returns plain string values unchanged", () => {
    expect(resolveTextareaInputValue("hello", "")).toBe("hello");
  });

  test("falls back to composer plain text for content-change event objects", () => {
    expect(resolveTextareaInputValue({}, "typed text")).toBe("typed text");
  });

  test("accepts object payloads that include a value string", () => {
    expect(resolveTextareaInputValue({ value: "from-event" }, "")).toBe("from-event");
  });
});
