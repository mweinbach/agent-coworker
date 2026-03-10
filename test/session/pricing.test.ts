import { describe, expect, it } from "bun:test";

import {
    resolveModelPricing,
    calculateTokenCost,
    formatCost,
    formatTokenCount,
    listPricingCatalog,
} from "../../src/session/pricing";

describe("pricing", () => {
    describe("resolveModelPricing", () => {
        it("resolves exact match for anthropic model", () => {
            const pricing = resolveModelPricing("anthropic", "claude-sonnet-4-5");
            expect(pricing).not.toBeNull();
            expect(pricing!.inputPerMillion).toBe(3);
            expect(pricing!.outputPerMillion).toBe(15);
        });

        it("resolves exact match for openai gpt-5.4 pricing", () => {
            const pricing = resolveModelPricing("openai", "gpt-5.4");
            expect(pricing).not.toBeNull();
            expect(pricing!.inputPerMillion).toBe(2.5);
            expect(pricing!.outputPerMillion).toBe(15);
            expect(pricing!.cachedInputPerMillion).toBe(0.25);
        });

        it("resolves exact match for google model", () => {
            const pricing = resolveModelPricing("google", "gemini-3-flash-preview");
            expect(pricing).not.toBeNull();
            expect(pricing!.inputPerMillion).toBe(0.15);
        });

        it("resolves exact match for codex-cli gpt-5.4 pricing", () => {
            const pricing = resolveModelPricing("codex-cli", "gpt-5.4");
            expect(pricing).not.toBeNull();
            expect(pricing!.inputPerMillion).toBe(2.5);
            expect(pricing!.outputPerMillion).toBe(15);
            expect(pricing!.cachedInputPerMillion).toBe(0.25);
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
                    "openai:gpt-5.4": {
                        inputPerMillion: 7,
                        outputPerMillion: 14,
                    },
                }),
            };

            const pricing = resolveModelPricing("openai", "gpt-5.4", env);
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
            const pricing = resolveModelPricing("openai", "gpt-5.4")!;
            // 1M input + 500K output = (1) * 2.5 + (0.5) * 15 = 2.5 + 7.5 = 10
            const cost = calculateTokenCost(1_000_000, 500_000, pricing);
            expect(cost).toBeCloseTo(10, 4);
        });

        it("discounts cached prompt tokens when cached pricing is known", () => {
            const pricing = resolveModelPricing("openai", "gpt-5.4")!;
            // 1M prompt tokens with 400K cached + 500K output
            // 600K uncached input @ 2.5 = 1.5
            // 400K cached input @ 0.25 = 0.1
            // 500K output @ 15 = 7.5
            const cost = calculateTokenCost(1_000_000, 500_000, pricing, 400_000);
            expect(cost).toBeCloseTo(9.1, 4);
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
                expect(entry.pricing.inputPerMillion).toBeGreaterThan(0);
                expect(entry.pricing.outputPerMillion).toBeGreaterThan(0);
            }
        });

        it("includes all providers", () => {
            const catalog = listPricingCatalog();
            const providers = new Set(catalog.map((e) => e.provider));
            expect(providers.has("anthropic")).toBe(true);
            expect(providers.has("openai")).toBe(true);
            expect(providers.has("google")).toBe(true);
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
