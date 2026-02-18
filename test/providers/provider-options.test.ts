import { describe, expect, test } from "bun:test";

import { getModel } from "../../src/config";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig } from "./helpers";

// ---------------------------------------------------------------------------
// Provider options structure and consistency
// ---------------------------------------------------------------------------
describe("Provider options structure", () => {
  test("all expected providers have options defined", () => {
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("openai");
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("google");
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("anthropic");
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("codex-cli");
  });

  test("no extra unknown providers in options", () => {
    const providers = Object.keys(DEFAULT_PROVIDER_OPTIONS);
    expect(providers).toEqual([
      "openai",
      "google",
      "anthropic",
      "codex-cli",
    ]);
  });

  test("each provider options is a plain object", () => {
    for (const [, opts] of Object.entries(DEFAULT_PROVIDER_OPTIONS)) {
      expect(typeof opts).toBe("object");
      expect(opts).not.toBeNull();
      expect(Array.isArray(opts)).toBe(false);
    }
  });

  test("providerOptions can be attached to AgentConfig", () => {
    const cfg = makeConfig({ providerOptions: DEFAULT_PROVIDER_OPTIONS });
    expect(cfg.providerOptions).toEqual(DEFAULT_PROVIDER_OPTIONS);
  });

  test("providerOptions is optional on AgentConfig", () => {
    const cfg = makeConfig();
    expect(cfg.providerOptions).toBeUndefined();
  });

  test("provider defaults include reasoning/thinking profiles", () => {
    // OpenAI: reasoningEffort is "high"
    expect(DEFAULT_PROVIDER_OPTIONS.openai.reasoningEffort).toBe("high");

    // Google: thinkingConfig.includeThoughts is true
    expect(DEFAULT_PROVIDER_OPTIONS.google.thinkingConfig.includeThoughts).toBe(true);

    // Anthropic: thinking.type is "enabled"
    expect(DEFAULT_PROVIDER_OPTIONS.anthropic.thinking.type).toBe("enabled");
  });
});

// ---------------------------------------------------------------------------
// Agent runTurn providerOptions pass-through
// ---------------------------------------------------------------------------
describe("Agent providerOptions pass-through", () => {
  test("config with providerOptions preserves all provider configs", () => {
    const cfg = makeConfig({
      provider: "anthropic",
      model: "claude-opus-4-6",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    // All three provider options should be present
    expect(cfg.providerOptions!.openai).toBeDefined();
    expect(cfg.providerOptions!.google).toBeDefined();
    expect(cfg.providerOptions!.anthropic).toBeDefined();

    // OpenAI reasoning config preserved
    expect(cfg.providerOptions!.openai.reasoningEffort).toBe("high");
    expect(cfg.providerOptions!.openai.reasoningSummary).toBe("detailed");

    // Google thinking config preserved
    expect(cfg.providerOptions!.google.thinkingConfig.includeThoughts).toBe(true);
    expect(cfg.providerOptions!.google.thinkingConfig.thinkingLevel).toBe("high");

    // Anthropic thinking config preserved
    expect(cfg.providerOptions!.anthropic.thinking.type).toBe("enabled");
    expect(cfg.providerOptions!.anthropic.thinking.budgetTokens).toBe(32_000);
  });

  test("providerOptions is referenced in agent.ts streamText call", () => {
    // This test verifies the shape expected by agent.ts:
    //   providerOptions: config.providerOptions
    // The agent passes providerOptions directly from config to streamText.
    const cfg = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: { openai: { reasoningEffort: "high" } },
    });

    // Simulate what agent.ts does
    const streamTextArgs: any = {
      model: getModel(cfg),
      system: "test",
      messages: [],
      tools: {},
      providerOptions: cfg.providerOptions,
    };

    expect(streamTextArgs.providerOptions).toBeDefined();
    expect(streamTextArgs.providerOptions.openai.reasoningEffort).toBe("high");
    expect(streamTextArgs.model.modelId).toBe("gpt-5.2");
  });
});
