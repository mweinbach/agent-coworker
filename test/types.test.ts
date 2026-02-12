import { describe, expect, test } from "bun:test";
import { isProviderName, PROVIDER_NAMES } from "../src/types";

// ---------------------------------------------------------------------------
// PROVIDER_NAMES
// ---------------------------------------------------------------------------
describe("PROVIDER_NAMES", () => {
  test("contains exactly 6 providers", () => {
    expect(PROVIDER_NAMES).toHaveLength(6);
  });

  test("contains expected provider names", () => {
    expect(PROVIDER_NAMES).toContain("google");
    expect(PROVIDER_NAMES).toContain("openai");
    expect(PROVIDER_NAMES).toContain("anthropic");
    expect(PROVIDER_NAMES).toContain("gemini-cli");
    expect(PROVIDER_NAMES).toContain("codex-cli");
    expect(PROVIDER_NAMES).toContain("claude-code");
  });
});

// ---------------------------------------------------------------------------
// isProviderName
// ---------------------------------------------------------------------------
describe("isProviderName", () => {
  // ---- Valid provider names ------------------------------------------------
  describe("returns true for all valid provider names", () => {
    test("google", () => {
      expect(isProviderName("google")).toBe(true);
    });

    test("openai", () => {
      expect(isProviderName("openai")).toBe(true);
    });

    test("anthropic", () => {
      expect(isProviderName("anthropic")).toBe(true);
    });

    test("gemini-cli", () => {
      expect(isProviderName("gemini-cli")).toBe(true);
    });

    test("codex-cli", () => {
      expect(isProviderName("codex-cli")).toBe(true);
    });

    test("claude-code", () => {
      expect(isProviderName("claude-code")).toBe(true);
    });
  });

  // ---- Invalid strings -----------------------------------------------------
  describe("returns false for invalid provider strings", () => {
    test("gpt", () => {
      expect(isProviderName("gpt")).toBe(false);
    });

    test("azure", () => {
      expect(isProviderName("azure")).toBe(false);
    });

    test("ollama", () => {
      expect(isProviderName("ollama")).toBe(false);
    });

    test("huggingface", () => {
      expect(isProviderName("huggingface")).toBe(false);
    });
  });

  // ---- Case sensitivity ----------------------------------------------------
  describe("is case-sensitive", () => {
    test("Google (capitalized)", () => {
      expect(isProviderName("Google")).toBe(false);
    });

    test("OPENAI (uppercase)", () => {
      expect(isProviderName("OPENAI")).toBe(false);
    });

    test("Anthropic (capitalized)", () => {
      expect(isProviderName("Anthropic")).toBe(false);
    });
  });

  // ---- Whitespace variants -------------------------------------------------
  describe("returns false for whitespace variants", () => {
    test("leading space: ' google'", () => {
      expect(isProviderName(" google")).toBe(false);
    });

    test("trailing space: 'openai '", () => {
      expect(isProviderName("openai ")).toBe(false);
    });

    test("both spaces: ' anthropic '", () => {
      expect(isProviderName(" anthropic ")).toBe(false);
    });
  });

  // ---- Non-string types ----------------------------------------------------
  describe("returns false for non-string types", () => {
    test("number 0", () => {
      expect(isProviderName(0)).toBe(false);
    });

    test("number 1", () => {
      expect(isProviderName(1)).toBe(false);
    });

    test("true", () => {
      expect(isProviderName(true)).toBe(false);
    });

    test("false", () => {
      expect(isProviderName(false)).toBe(false);
    });

    test("null", () => {
      expect(isProviderName(null)).toBe(false);
    });

    test("undefined", () => {
      expect(isProviderName(undefined)).toBe(false);
    });

    test("empty object", () => {
      expect(isProviderName({})).toBe(false);
    });

    test("empty array", () => {
      expect(isProviderName([])).toBe(false);
    });

    test("NaN", () => {
      expect(isProviderName(NaN)).toBe(false);
    });
  });

  // ---- Empty string --------------------------------------------------------
  test("returns false for empty string", () => {
    expect(isProviderName("")).toBe(false);
  });

  // ---- Partial matches -----------------------------------------------------
  describe("returns false for partial matches", () => {
    test("goo (prefix of google)", () => {
      expect(isProviderName("goo")).toBe(false);
    });

    test("open (prefix of openai)", () => {
      expect(isProviderName("open")).toBe(false);
    });

    test("claude (prefix of claude-code)", () => {
      expect(isProviderName("claude")).toBe(false);
    });
  });

  // ---- Extra suffix --------------------------------------------------------
  describe("returns false for names with extra suffixes", () => {
    test("google-ai", () => {
      expect(isProviderName("google-ai")).toBe(false);
    });

    test("openai-v2", () => {
      expect(isProviderName("openai-v2")).toBe(false);
    });
  });
});
