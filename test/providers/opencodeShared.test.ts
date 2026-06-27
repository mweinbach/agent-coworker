import { describe, expect, test } from "bun:test";

import { listSupportedModelIds, supportsImageInput } from "../../src/models/registry";
import {
  getOpenCodeModelPricing,
  getOpenCodeModelSpec,
  getOpenCodeProviderConfig,
  isOpenCodeModelSupportedByProvider,
} from "../../src/providers/opencodeShared";

describe("providers/opencodeShared", () => {
  test("keeps provider model catalogs aligned with the static registry", () => {
    for (const provider of ["opencode-go", "opencode-zen"] as const) {
      const configuredIds = [...getOpenCodeProviderConfig(provider).availableModels].sort();
      const registryIds = [...listSupportedModelIds(provider)].sort();

      expect(configuredIds).toEqual(registryIds);
    }
  });

  test("keeps runtime specs aligned with registry image capabilities", () => {
    for (const provider of ["opencode-go", "opencode-zen"] as const) {
      for (const modelId of getOpenCodeProviderConfig(provider).availableModels) {
        const spec = getOpenCodeModelSpec(modelId);

        expect(spec).not.toBeNull();
        expect(spec?.input.includes("image") ?? false).toBe(supportsImageInput(provider, modelId));
      }
    }
  });

  test("keeps OpenCode Zen runtime pricing available for every selectable Zen model", () => {
    for (const modelId of getOpenCodeProviderConfig("opencode-zen").availableModels) {
      const pricing = getOpenCodeModelPricing("opencode-zen", modelId);

      expect(pricing).not.toBeNull();
      expect(pricing?.input).toBeGreaterThanOrEqual(0);
      expect(pricing?.output).toBeGreaterThanOrEqual(0);
      expect(pricing?.cacheRead).toBeGreaterThanOrEqual(0);
      expect(pricing?.cacheWrite).toBeGreaterThanOrEqual(0);
    }
  });

  test("enforces Go and Zen model boundaries", () => {
    expect(isOpenCodeModelSupportedByProvider("opencode-go", "qwen3.7-max")).toBe(true);
    expect(isOpenCodeModelSupportedByProvider("opencode-zen", "qwen3.7-max")).toBe(false);

    expect(isOpenCodeModelSupportedByProvider("opencode-zen", "claude-opus-4-8")).toBe(true);
    expect(isOpenCodeModelSupportedByProvider("opencode-go", "claude-opus-4-8")).toBe(false);

    expect(isOpenCodeModelSupportedByProvider("opencode-go", "glm-5")).toBe(true);
    expect(isOpenCodeModelSupportedByProvider("opencode-zen", "glm-5")).toBe(true);
  });
});
