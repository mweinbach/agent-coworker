import { describe, expect, it } from "bun:test";

import {
  calculateTokenCostBreakdown,
  formatCost,
  formatTokenCount,
  type ModelPricing,
} from "../../src/session/pricing";

const SONNET_LIKE: ModelPricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cachedInputPerMillion: 0.3,
  cacheWriteInputPerMillion: 3.75,
};

const GPT_LIKE: ModelPricing = {
  inputPerMillion: 1.75,
  outputPerMillion: 14,
  cachedInputPerMillion: 0.175,
};

const LONG_CONTEXT: ModelPricing = {
  inputPerMillion: 5,
  outputPerMillion: 30,
  cachedInputPerMillion: 0.5,
  longContextThresholdTokens: 272_000,
  longContextInputPerMillion: 10,
  longContextOutputPerMillion: 45,
  longContextCachedInputPerMillion: 1,
};

const total = (...args: Parameters<typeof calculateTokenCostBreakdown>) =>
  calculateTokenCostBreakdown(...args).totalCostUsd;

describe("pricing", () => {
  describe("calculateTokenCostBreakdown", () => {
    it("calculates cost correctly for input and output tokens", () => {
      // (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15 = 0.003 + 0.0075 = 0.0105
      expect(total(1000, 500, SONNET_LIKE)).toBeCloseTo(0.0105, 6);
    });

    it("calculates zero cost for zero tokens", () => {
      expect(total(0, 0, SONNET_LIKE)).toBe(0);
    });

    it("discounts cached prompt tokens when cached pricing is known", () => {
      // 600K uncached @ 1.75 = 1.05; 400K cached @ 0.175 = 0.07; 500K output @ 14 = 7
      expect(total(1_000_000, 500_000, GPT_LIKE, 400_000)).toBeCloseTo(8.12, 4);
    });

    it("falls back to input pricing for cached tokens without cached pricing", () => {
      const pricing: ModelPricing = { inputPerMillion: 2, outputPerMillion: 8 };
      expect(total(1_000_000, 0, pricing, 400_000)).toBeCloseTo(2, 6);
    });

    it("prices cache reads and cache writes as separate prompt-token buckets", () => {
      const breakdown = calculateTokenCostBreakdown(
        1_000_000,
        500_000,
        SONNET_LIKE,
        400_000,
        100_000,
      );

      expect(breakdown.inputCostUsd).toBeCloseTo(1.5, 4);
      expect(breakdown.cachedInputCostUsd).toBeCloseTo(0.12, 4);
      expect(breakdown.cacheWriteInputCostUsd).toBeCloseTo(0.375, 4);
      expect(breakdown.outputCostUsd).toBeCloseTo(7.5, 4);
      expect(breakdown.totalCostUsd).toBeCloseTo(9.495, 4);
    });

    it("clamps cached and cache-write tokens to the prompt token count", () => {
      const breakdown = calculateTokenCostBreakdown(100, 0, SONNET_LIKE, 80, 50);
      expect(breakdown.inputCostUsd).toBe(0);
      expect(breakdown.cachedInputCostUsd).toBeCloseTo((80 / 1_000_000) * 0.3, 10);
      expect(breakdown.cacheWriteInputCostUsd).toBeCloseTo((20 / 1_000_000) * 3.75, 10);
    });

    it("applies long-context pricing above the threshold", () => {
      // 200K uncached @ 10 = 2; 100K cached @ 1 = 0.1; 100K output @ 45 = 4.5
      expect(total(300_000, 100_000, LONG_CONTEXT, 100_000)).toBeCloseTo(6.6, 4);
    });

    it("keeps short-context pricing at the threshold", () => {
      // 172K uncached @ 5 = 0.86; 100K cached @ 0.5 = 0.05; 100K output @ 30 = 3
      expect(total(272_000, 100_000, LONG_CONTEXT, 100_000)).toBeCloseTo(3.91, 4);
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
});
