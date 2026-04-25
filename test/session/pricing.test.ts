import { describe, expect, it } from "bun:test";

import {
  calculateTokenCost,
  formatCost,
  formatTokenCount,
  listPricingCatalog,
  resolveModelPricing,
} from "../../src/session/pricing";

describe("pricing", () => {
  describe("resolveModelPricing", () => {
    it("resolves exact match for anthropic model", () => {
      const pricing = resolveModelPricing("anthropic", "claude-sonnet-4-5");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(3);
      expect(pricing!.outputPerMillion).toBe(15);
    });

    it("resolves exact match for openai gpt-5.2 pricing", () => {
      const pricing = resolveModelPricing("openai", "gpt-5.2");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(1.75);
      expect(pricing!.outputPerMillion).toBe(14);
      expect(pricing!.cachedInputPerMillion).toBe(0.175);
    });

    it("resolves exact match for openai gpt-5.4-mini pricing", () => {
      const pricing = resolveModelPricing("openai", "gpt-5.4-mini");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(0.75);
      expect(pricing!.outputPerMillion).toBe(4.5);
      expect(pricing!.cachedInputPerMillion).toBe(0.075);
    });

    it("resolves exact match for openai gpt-5.5 pricing", () => {
      const pricing = resolveModelPricing("openai", "gpt-5.5");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(5);
      expect(pricing!.outputPerMillion).toBe(30);
      expect(pricing!.cachedInputPerMillion).toBe(0.5);
    });

    it("resolves exact match for google model", () => {
      const pricing = resolveModelPricing("google", "gemini-3-flash-preview");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(0.5);
      expect(pricing!.outputPerMillion).toBe(3);
      expect(pricing!.cachedInputPerMillion).toBe(0.05);
    });

    it("resolves exact match for gemini-3.1-flash-lite-preview pricing", () => {
      const pricing = resolveModelPricing("google", "gemini-3.1-flash-lite-preview");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(0.25);
      expect(pricing!.outputPerMillion).toBe(1.5);
      expect(pricing!.cachedInputPerMillion).toBe(0.025);
    });

    it("resolves exact match for baseten models", () => {
      const kimi = resolveModelPricing("baseten", "moonshotai/Kimi-K2.5");
      expect(kimi).not.toBeNull();
      expect(kimi!.inputPerMillion).toBe(0.6);
      expect(kimi!.outputPerMillion).toBe(3);

      const glm = resolveModelPricing("baseten", "zai-org/GLM-5");
      expect(glm).not.toBeNull();
      expect(glm!.inputPerMillion).toBe(0.95);
      expect(glm!.outputPerMillion).toBe(3.15);

      expect(resolveModelPricing("baseten", "nvidia/Nemotron-120B-A12B")).toBeNull();
    });

    it("resolves exact match for together models", () => {
      const kimi = resolveModelPricing("together", "moonshotai/Kimi-K2.5");
      expect(kimi).not.toBeNull();
      expect(kimi!.inputPerMillion).toBe(0.5);
      expect(kimi!.outputPerMillion).toBe(2.8);

      const qwen = resolveModelPricing("together", "Qwen/Qwen3.5-397B-A17B");
      expect(qwen).not.toBeNull();
      expect(qwen!.inputPerMillion).toBe(0.6);
      expect(qwen!.outputPerMillion).toBe(3.6);

      const glm = resolveModelPricing("together", "zai-org/GLM-5");
      expect(glm).not.toBeNull();
      expect(glm!.inputPerMillion).toBe(1);
      expect(glm!.outputPerMillion).toBe(3.2);
    });

    it("returns null for nvidia models without local pricing", () => {
      expect(resolveModelPricing("nvidia", "nvidia/nemotron-3-super-120b-a12b")).toBeNull();
    });

    it("returns null for opencode-go models without local pricing", () => {
      expect(resolveModelPricing("opencode-go", "glm-5")).toBeNull();
      expect(resolveModelPricing("opencode-go", "kimi-k2.5")).toBeNull();
    });

    it("ignores env pricing overrides for opencode-go because local pricing is intentionally unsupported", () => {
      const env = {
        COWORK_MODEL_PRICING_OVERRIDES: JSON.stringify({
          "opencode-go:glm-5": {
            inputPerMillion: 1,
            outputPerMillion: 2,
          },
        }),
      };

      expect(resolveModelPricing("opencode-go", "glm-5", env)).toBeNull();
    });

    it("resolves exact match for opencode-zen models", () => {
      const glm = resolveModelPricing("opencode-zen", "glm-5");
      expect(glm).not.toBeNull();
      expect(glm!.inputPerMillion).toBe(1);
      expect(glm!.outputPerMillion).toBe(3.2);
      expect(glm!.cachedInputPerMillion).toBe(0.2);

      const kimi = resolveModelPricing("opencode-zen", "kimi-k2.5");
      expect(kimi).not.toBeNull();
      expect(kimi!.inputPerMillion).toBe(0.6);
      expect(kimi!.outputPerMillion).toBe(3);
      expect(kimi!.cachedInputPerMillion).toBe(0.08);

      const nemotron = resolveModelPricing("opencode-zen", "nemotron-3-super-free");
      expect(nemotron).not.toBeNull();
      expect(nemotron!.inputPerMillion).toBe(0);
      expect(nemotron!.outputPerMillion).toBe(0);

      const mimo = resolveModelPricing("opencode-zen", "mimo-v2-flash-free");
      expect(mimo).not.toBeNull();
      expect(mimo!.inputPerMillion).toBe(0);
      expect(mimo!.outputPerMillion).toBe(0);

      const bigPickle = resolveModelPricing("opencode-zen", "big-pickle");
      expect(bigPickle).not.toBeNull();
      expect(bigPickle!.inputPerMillion).toBe(0);
      expect(bigPickle!.outputPerMillion).toBe(0);

      const minimaxFree = resolveModelPricing("opencode-zen", "minimax-m2.5-free");
      expect(minimaxFree).not.toBeNull();
      expect(minimaxFree!.inputPerMillion).toBe(0);
      expect(minimaxFree!.outputPerMillion).toBe(0);

      const minimax = resolveModelPricing("opencode-zen", "minimax-m2.5");
      expect(minimax).not.toBeNull();
      expect(minimax!.inputPerMillion).toBe(0.3);
      expect(minimax!.outputPerMillion).toBe(1.2);
      expect(minimax!.cachedInputPerMillion).toBe(0.06);
    });

    it("resolves exact match for codex-cli gpt-5.4 pricing", () => {
      const pricing = resolveModelPricing("codex-cli", "gpt-5.4");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(2.5);
      expect(pricing!.outputPerMillion).toBe(15);
      expect(pricing!.cachedInputPerMillion).toBe(0.25);
    });

    it("resolves exact match for codex-cli gpt-5.5 pricing", () => {
      const pricing = resolveModelPricing("codex-cli", "gpt-5.5");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(5);
      expect(pricing!.outputPerMillion).toBe(30);
      expect(pricing!.cachedInputPerMillion).toBe(0.5);
    });

    it("resolves exact match for codex-cli gpt-5.4-mini pricing", () => {
      const pricing = resolveModelPricing("codex-cli", "gpt-5.4-mini");
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerMillion).toBe(0.75);
      expect(pricing!.outputPerMillion).toBe(4.5);
      expect(pricing!.cachedInputPerMillion).toBe(0.075);
    });

    it("returns null for unknown provider/model", () => {
      expect(resolveModelPricing("anthropic", "nonexistent-model")).toBeNull();
      expect(resolveModelPricing("google", "unknown-model")).toBeNull();
    });

    it("includes cached input pricing when available", () => {
      const pricing = resolveModelPricing("anthropic", "claude-opus-4-6");
      expect(pricing).not.toBeNull();
      expect(pricing!.cachedInputPerMillion).toBe(1.875);
    });

    it("applies env overrides for custom pricing entries", () => {
      const env = {
        COWORK_MODEL_PRICING_OVERRIDES: JSON.stringify({
          "openai:gpt-custom-preview": {
            inputPerMillion: 9,
            outputPerMillion: 27,
            cachedInputPerMillion: 0.9,
          },
        }),
      };

      const pricing = resolveModelPricing("openai", "gpt-custom-preview", env);
      expect(pricing).toEqual({
        inputPerMillion: 9,
        outputPerMillion: 27,
        cachedInputPerMillion: 0.9,
      });
    });

    it("lets env overrides replace built-in pricing entries", () => {
      const env = {
        COWORK_MODEL_PRICING_OVERRIDES: JSON.stringify({
          "openai:gpt-5.2": {
            inputPerMillion: 7,
            outputPerMillion: 14,
          },
        }),
      };

      const pricing = resolveModelPricing("openai", "gpt-5.2", env);
      expect(pricing).toEqual({
        inputPerMillion: 7,
        outputPerMillion: 14,
      });
    });
  });

  describe("calculateTokenCost", () => {
    it("calculates cost correctly for known pricing", () => {
      const pricing = resolveModelPricing("anthropic", "claude-sonnet-4-5")!;
      // 1000 input tokens + 500 output tokens
      // (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15 = 0.003 + 0.0075 = 0.0105
      const cost = calculateTokenCost(1000, 500, pricing);
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it("calculates zero cost for zero tokens", () => {
      const pricing = resolveModelPricing("anthropic", "claude-sonnet-4-5")!;
      expect(calculateTokenCost(0, 0, pricing)).toBe(0);
    });

    it("calculates cost for large token counts", () => {
      const pricing = resolveModelPricing("openai", "gpt-5.2")!;
      // 1M input + 500K output = (1) * 1.75 + (0.5) * 14 = 1.75 + 7 = 8.75
      const cost = calculateTokenCost(1_000_000, 500_000, pricing);
      expect(cost).toBeCloseTo(8.75, 4);
    });

    it("discounts cached prompt tokens when cached pricing is known", () => {
      const pricing = resolveModelPricing("openai", "gpt-5.2")!;
      // 1M prompt tokens with 400K cached + 500K output
      // 600K uncached input @ 1.75 = 1.05
      // 400K cached input @ 0.175 = 0.07
      // 500K output @ 14 = 7
      const cost = calculateTokenCost(1_000_000, 500_000, pricing, 400_000);
      expect(cost).toBeCloseTo(8.12, 4);
    });
  });

  describe("formatCost", () => {
    it("formats zero", () => {
      expect(formatCost(0)).toBe("$0.00");
    });

    it("formats small amounts with 4 decimal places", () => {
      expect(formatCost(0.001)).toBe("$0.0010");
      expect(formatCost(0.0001)).toBe("$0.0001");
    });

    it("formats medium amounts with 2 decimal places", () => {
      expect(formatCost(0.05)).toBe("$0.05");
      expect(formatCost(0.99)).toBe("$0.99");
    });

    it("formats large amounts with 2 decimal places", () => {
      expect(formatCost(1.23)).toBe("$1.23");
      expect(formatCost(10.5)).toBe("$10.50");
    });
  });

  describe("formatTokenCount", () => {
    it("formats small counts as-is", () => {
      expect(formatTokenCount(0)).toBe("0");
      expect(formatTokenCount(999)).toBe("999");
    });

    it("formats thousands with k suffix", () => {
      expect(formatTokenCount(1000)).toBe("1.0k");
      expect(formatTokenCount(1500)).toBe("1.5k");
      expect(formatTokenCount(999999)).toBe("1000.0k");
    });

    it("formats millions with M suffix", () => {
      expect(formatTokenCount(1_000_000)).toBe("1.00M");
      expect(formatTokenCount(2_500_000)).toBe("2.50M");
    });
  });

  describe("listPricingCatalog", () => {
    it("returns non-empty array", () => {
      const catalog = listPricingCatalog();
      expect(catalog.length).toBeGreaterThan(0);
    });

    it("entries have required fields", () => {
      const catalog = listPricingCatalog();
      for (const entry of catalog) {
        expect(entry.provider).toBeDefined();
        expect(entry.model).toBeDefined();
        expect(entry.pricing.inputPerMillion).toBeGreaterThanOrEqual(0);
        expect(entry.pricing.outputPerMillion).toBeGreaterThanOrEqual(0);
      }
    });

    it("includes all providers", () => {
      const catalog = listPricingCatalog();
      const providers = new Set(catalog.map((e) => e.provider));
      expect(providers.has("anthropic")).toBe(true);
      expect(providers.has("baseten")).toBe(true);
      expect(providers.has("openai")).toBe(true);
      expect(providers.has("google")).toBe(true);
      expect(providers.has("opencode-zen")).toBe(true);
      expect(providers.has("codex-cli")).toBe(true);
    });

    it("includes env-provided pricing entries in the catalog", () => {
      const env = {
        COWORK_MODEL_PRICING_OVERRIDES: JSON.stringify({
          "google:gemini-special-preview": {
            inputPerMillion: 0.5,
            outputPerMillion: 1.5,
          },
        }),
      };

      const catalog = listPricingCatalog(env);
      expect(catalog).toContainEqual({
        provider: "google",
        model: "gemini-special-preview",
        pricing: {
          inputPerMillion: 0.5,
          outputPerMillion: 1.5,
        },
      });
    });
  });
});
