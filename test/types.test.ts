import { describe, expect, test } from "bun:test";
import { isProviderName, PROVIDER_NAMES, resolveProviderName } from "../src/types";

// ---------------------------------------------------------------------------
// PROVIDER_NAMES
// ---------------------------------------------------------------------------
describe("PROVIDER_NAMES", () => {
  test("contains exactly 10 providers", () => {
    expect(PROVIDER_NAMES).toHaveLength(10);
  });

  test("contains expected provider names", () => {
    expect(PROVIDER_NAMES).toContain("google");
    expect(PROVIDER_NAMES).toContain("openai");
    expect(PROVIDER_NAMES).toContain("anthropic");
    expect(PROVIDER_NAMES).toContain("baseten");
    expect(PROVIDER_NAMES).toContain("together");
    expect(PROVIDER_NAMES).toContain("nvidia");
    expect(PROVIDER_NAMES).toContain("lmstudio");
    expect(PROVIDER_NAMES).toContain("opencode-go");
    expect(PROVIDER_NAMES).toContain("opencode-zen");
    expect(PROVIDER_NAMES).toContain("codex-cli");
  });
});

describe("resolveProviderName", () => {
  test("returns exact provider names", () => {
    expect(resolveProviderName("google")).toBe("google");
    expect(resolveProviderName("openai")).toBe("openai");
    expect(resolveProviderName("anthropic")).toBe("anthropic");
    expect(resolveProviderName("baseten")).toBe("baseten");
    expect(resolveProviderName("together")).toBe("together");
    expect(resolveProviderName("nvidia")).toBe("nvidia");
    expect(resolveProviderName("lmstudio")).toBe("lmstudio");
    expect(resolveProviderName("opencode-go")).toBe("opencode-go");
    expect(resolveProviderName("opencode-zen")).toBe("opencode-zen");
    expect(resolveProviderName("codex-cli")).toBe("codex-cli");
  });

  test("returns null for unknown provider names", () => {
    expect(resolveProviderName("legacy-google-cli")).toBeNull();
    expect(resolveProviderName("legacy-anthropic-cli")).toBeNull();
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

    test("baseten", () => {
      expect(isProviderName("baseten")).toBe(true);
    });

    test("together", () => {
      expect(isProviderName("together")).toBe(true);
    });

    test("nvidia", () => {
      expect(isProviderName("nvidia")).toBe(true);
    });

    test("lmstudio", () => {
      expect(isProviderName("lmstudio")).toBe(true);
    });

    test("codex-cli", () => {
      expect(isProviderName("codex-cli")).toBe(true);
    });

    test("opencode-go", () => {
      expect(isProviderName("opencode-go")).toBe(true);
    });

    test("opencode-zen", () => {
      expect(isProviderName("opencode-zen")).toBe(true);
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

    test("claude", () => {
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
