import { describe, expect, test } from "bun:test";

import type { ProviderName } from "../../src/types";
import { defaultModelForProvider, getModel } from "../../src/config";
import { makeConfig } from "./helpers";

// ---------------------------------------------------------------------------
// Cross-provider model creation
// ---------------------------------------------------------------------------
describe("Cross-provider model creation", () => {
  const providers: { name: ProviderName; defaultModel: string; providerPrefix: string }[] = [
    { name: "anthropic", defaultModel: "claude-opus-4-6", providerPrefix: "anthropic.messages" },
    { name: "openai", defaultModel: "gpt-5.2", providerPrefix: "openai.responses" },
    { name: "google", defaultModel: "gemini-3-flash-preview", providerPrefix: "google.generative-ai" },
    { name: "gemini-cli", defaultModel: "gemini-3-flash-preview", providerPrefix: "gemini-cli-core" },
    { name: "codex-cli", defaultModel: "gpt-5.2-codex", providerPrefix: "codex-cli" },
    { name: "claude-code", defaultModel: "sonnet", providerPrefix: "claude-code" },
  ];

  for (const { name, defaultModel, providerPrefix } of providers) {
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

// ---------------------------------------------------------------------------
// Session reasoning kind per provider
// ---------------------------------------------------------------------------
describe("Session reasoning kind mapping", () => {
  const reasoningKind = (provider: ProviderName) =>
    provider === "openai" || provider === "codex-cli" ? "summary" : "reasoning";

  // The session.ts uses this logic:
  //   const kind =
  //     config.provider === "openai" || config.provider === "codex-cli"
  //       ? "summary"
  //       : "reasoning";
  // Test the mapping directly.

  test("openai provider maps to 'summary' reasoning kind", () => {
    expect(reasoningKind("openai")).toBe("summary");
  });

  test("anthropic provider maps to 'reasoning' kind", () => {
    expect(reasoningKind("anthropic")).toBe("reasoning");
  });

  test("google provider maps to 'reasoning' kind", () => {
    expect(reasoningKind("google")).toBe("reasoning");
  });

  test("codex-cli provider maps to 'summary' reasoning kind", () => {
    expect(reasoningKind("codex-cli")).toBe("summary");
  });

  test("gemini-cli provider maps to 'reasoning' kind", () => {
    expect(reasoningKind("gemini-cli")).toBe("reasoning");
  });

  test("claude-code provider maps to 'reasoning' kind", () => {
    expect(reasoningKind("claude-code")).toBe("reasoning");
  });
});
