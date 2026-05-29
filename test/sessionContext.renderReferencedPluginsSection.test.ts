import { describe, expect, test } from "bun:test";

import { renderReferencedPluginsSection } from "../src/sessionContext/renderReferencedPluginsSection";
import { buildTurnSystemPrompt } from "../src/turnSystemPrompt";

describe("renderReferencedPluginsSection", () => {
  test("returns empty string for null/empty", () => {
    expect(renderReferencedPluginsSection(null)).toBe("");
    expect(renderReferencedPluginsSection(undefined)).toBe("");
    expect(renderReferencedPluginsSection([])).toBe("");
  });

  test("renders a heading and bundled skill names per plugin", () => {
    const section = renderReferencedPluginsSection([
      { name: "acme", displayName: "Acme Suite", skillNames: ["docs", "sheets"] },
      { name: "beta", displayName: "Beta", skillNames: [] },
    ]);
    expect(section).toContain("## Referenced Plugins");
    expect(section).toContain("- Acme Suite (bundled skills: docs, sheets)");
    expect(section).toContain("- Beta");
    // uses the real callable tool id
    expect(section).toContain("`skill` tool");
  });

  test("falls back to name when displayName is blank and drops blank skill names", () => {
    const section = renderReferencedPluginsSection([
      { name: "gamma", displayName: "  ", skillNames: ["a", "  ", "b"] },
    ]);
    expect(section).toContain("- gamma (bundled skills: a, b)");
  });
});

describe("buildTurnSystemPrompt with referenced plugins", () => {
  test("appends the referenced-plugins section when provided", () => {
    const prompt = buildTurnSystemPrompt("BASE PROMPT", null, [], null, [
      { name: "acme", displayName: "Acme Suite", skillNames: ["docs"] },
    ]);
    expect(prompt).toContain("BASE PROMPT");
    expect(prompt).toContain("## Referenced Plugins");
    expect(prompt).toContain("Acme Suite");
  });

  test("omits the section when no plugins are referenced", () => {
    const prompt = buildTurnSystemPrompt("BASE PROMPT", null, [], null, []);
    expect(prompt).not.toContain("## Referenced Plugins");
  });
});
