import { describe, expect, test } from "bun:test";

import { parseStructuredToolInput } from "../src/shared/structuredInput";

describe("parseStructuredToolInput", () => {
  test("parses a JSON object", () => {
    expect(parseStructuredToolInput('{\"name\":\"read\",\"args\":{\"path\":\"README.md\"}}')).toEqual({
      name: "read",
      args: { path: "README.md" },
    });
  });

  test("parses a JSON array", () => {
    expect(parseStructuredToolInput("[1, \"two\", {\"three\": 3}]")).toEqual([1, "two", { three: 3 }]);
  });

  test("trims surrounding whitespace before parsing", () => {
    expect(parseStructuredToolInput("  {\"ok\":true}  ")).toEqual({ ok: true });
  });

  test("returns undefined for embedded JSON snippets", () => {
    expect(parseStructuredToolInput("tool args: {\"path\":\"src\"}")).toBeUndefined();
  });

  test("returns undefined for non-object/non-array JSON values", () => {
    expect(parseStructuredToolInput("\"text\"")).toBeUndefined();
    expect(parseStructuredToolInput("42")).toBeUndefined();
    expect(parseStructuredToolInput("true")).toBeUndefined();
    expect(parseStructuredToolInput("null")).toBeUndefined();
  });

  test("returns undefined for invalid or empty input", () => {
    expect(parseStructuredToolInput("")).toBeUndefined();
    expect(parseStructuredToolInput("   ")).toBeUndefined();
    expect(parseStructuredToolInput("{not-valid-json}")).toBeUndefined();
  });
});
