import { extractTriggers } from "../src/skills/index";
import { describe, test, expect } from "bun:test";

describe("extractTriggers", () => {
  test("extracts triggers with standard formatting", () => {
    const content = "TRIGGERS: a, b";
    expect(extractTriggers("test", content)).toEqual(["a", "b"]);
  });

  test("extracts triggers with leading whitespace", () => {
    const content = "  TRIGGERS: a, b";
    expect(extractTriggers("test", content)).toEqual(["a", "b"]);
  });

  test("extracts triggers with spaces around colon", () => {
    const content = "TRIGGERS : a, b";
    expect(extractTriggers("test", content)).toEqual(["a", "b"]);
  });

  test("extracts triggers with case insensitivity", () => {
    const content = "triggers: a, b";
    expect(extractTriggers("test", content)).toEqual(["a", "b"]);
  });

  test("extracts triggers with special characters", () => {
    const content = "TRIGGERS: @home, #work, c++, node.js";
    expect(extractTriggers("test", content)).toEqual(["@home", "#work", "c++", "node.js"]);
  });

  test("handles empty values and trailing commas", () => {
    const content = "TRIGGERS: a,, b,";
    expect(extractTriggers("test", content)).toEqual(["a", "b"]);
  });

  test("returns defaults if no match found (known skill)", () => {
    const content = "No triggers here";
    expect(extractTriggers("pdf", content)).toEqual(["pdf", ".pdf", "form", "merge", "split"]);
  });

  test("returns name as default if no match found (unknown skill)", () => {
    const content = "No triggers here";
    expect(extractTriggers("unknown-skill", content)).toEqual(["unknown-skill"]);
  });
});
