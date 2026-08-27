import { describe, expect, test } from "bun:test";

import { fnv1a32 } from "../src/shared/fnv1a";

describe("persisted workspace hashing", () => {
  test.each([
    ["", "811c9dc5"],
    ["hello", "4f9f2cab"],
    ["/tmp/project", "451426b1"],
    ["C:\\Users\\example\\project", "318a069f"],
    ["🧠", "dd2c04d3"],
    ["\0", "050c5d1f"],
    ["ws://127.0.0.1:7337/ws\0/tmp/workspace-one", "2ab0a350"],
  ])("preserves the UTF-16 hash and zero padding for %j", (value, expected) => {
    expect(fnv1a32(value)).toBe(expected);
  });
});
