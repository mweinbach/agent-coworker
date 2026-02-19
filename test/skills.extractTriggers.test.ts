import { describe, expect, test } from "bun:test";

import { extractTriggers } from "../src/skills/index";

describe("extractTriggers", () => {
  test("extracts triggers from frontmatter triggers string", () => {
    expect(extractTriggers("test", { triggers: "a, b" })).toEqual(["a", "b"]);
  });

  test("extracts triggers from frontmatter triggers array", () => {
    expect(extractTriggers("test", { triggers: ["a", "b"] })).toEqual(["a", "b"]);
  });

  test("extracts triggers from metadata.triggers", () => {
    expect(extractTriggers("test", { metadata: { triggers: "@home, #work, c++, node.js" } })).toEqual([
      "@home",
      "#work",
      "c++",
      "node.js",
    ]);
  });

  test("filters empty values in trigger strings", () => {
    expect(extractTriggers("test", { triggers: "a,, b," })).toEqual(["a", "b"]);
  });

  test("returns defaults if no trigger metadata is provided (known skill)", () => {
    expect(extractTriggers("pdf", { name: "pdf" })).toEqual(["pdf", ".pdf", "form", "merge", "split"]);
  });

  test("returns name as default if no trigger metadata is provided (unknown skill)", () => {
    expect(extractTriggers("unknown-skill", { name: "unknown-skill" })).toEqual(["unknown-skill"]);
  });
});
