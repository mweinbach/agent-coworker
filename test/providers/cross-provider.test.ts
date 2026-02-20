import { describe, expect, test } from "bun:test";

import type { ProviderName } from "../../src/types";
import { PROVIDER_NAMES } from "../../src/types";
import { defaultModelForProvider, getModel } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
import { makeConfig } from "./helpers";

// ---------------------------------------------------------------------------
// Cross-provider model creation
// ---------------------------------------------------------------------------
describe("Cross-provider model creation", () => {
  const providers: { name: ProviderName; providerPrefix: string }[] = [
    { name: "anthropic", providerPrefix: "anthropic.messages" },
    { name: "openai", providerPrefix: "openai.responses" },
    { name: "google", providerPrefix: "google.generative-ai" },
    { name: "codex-cli", providerPrefix: "codex-cli.responses" },
  ];

  for (const { name, providerPrefix } of providers) {
    const defaultModel = PROVIDER_MODEL_CATALOG[name].defaultModel;

    test(`${name}: default model is ${defaultModel}`, () => {
      expect(defaultModelForProvider(name)).toBe(defaultModel);
    });

    test(`${name}: getModel returns model with correct provider prefix`, () => {
      const cfg = makeConfig({ provider: name, model: defaultModel });
      const model = getModel(cfg);
      expect(model.provider).toBe(providerPrefix);
    });

    test(`${name}: getModel returns v3 specification`, () => {
      const cfg = makeConfig({ provider: name, model: defaultModel });
      const model = getModel(cfg);
      expect(model.specificationVersion).toBe("v3");
    });

    test(`${name}: model override works correctly`, () => {
      const cfg = makeConfig({ provider: name, model: "wrong-model" });
      const model = getModel(cfg, defaultModel);
      expect(model.modelId).toBe(defaultModel);
    });
  }
});

describe("Provider model catalog invariants", () => {
  for (const provider of PROVIDER_NAMES) {
    test(`${provider}: available model list is non-empty`, () => {
      expect(PROVIDER_MODEL_CATALOG[provider].availableModels.length).toBeGreaterThan(0);
    });

    test(`${provider}: default model exists in available models`, () => {
      expect(PROVIDER_MODEL_CATALOG[provider].availableModels).toContain(PROVIDER_MODEL_CATALOG[provider].defaultModel);
    });
  }
});

// ---------------------------------------------------------------------------
// Session reasoning kind per provider (tests the real function)
// ---------------------------------------------------------------------------
import { reasoningModeForProvider } from "../../src/server/modelStream";

describe("Session reasoning kind mapping", () => {
  test("openai provider maps to 'summary' reasoning kind", () => {
    expect(reasoningModeForProvider("openai")).toBe("summary");
  });

  test("anthropic provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("anthropic")).toBe("reasoning");
  });

  test("google provider maps to 'reasoning' kind", () => {
    expect(reasoningModeForProvider("google")).toBe("reasoning");
  });

  test("codex-cli provider maps to 'summary' reasoning kind", () => {
    expect(reasoningModeForProvider("codex-cli")).toBe("summary");
  });

});
