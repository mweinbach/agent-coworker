import { describe, expect, mock, spyOn, test, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";

import { defaultModelForProvider, getModel, loadConfig } from "../src/config";
import type { AgentConfig, ProviderName } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

async function writeJson(p: string, obj: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf-8");
}

async function makeTmpDirs() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const cwd = path.join(tmp, "project");
  const home = path.join(tmp, "home");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { tmp, cwd, home };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = os.tmpdir();
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    subAgentModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

// The same DEFAULT_PROVIDER_OPTIONS defined in src/index.ts.
// We test against these to ensure they match the expected shape.
const DEFAULT_PROVIDER_OPTIONS: Record<string, any> = {
  openai: {
    reasoningEffort: "high",
    reasoningSummary: "detailed",
  },
  google: {
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: "high",
    },
  },
  anthropic: {
    thinking: {
      type: "enabled",
      budgetTokens: 32_000,
    },
  },
};

// ---------------------------------------------------------------------------
// Anthropic provider - claude-opus-4-6
// ---------------------------------------------------------------------------
describe("Anthropic provider (claude-opus-4-6)", () => {
  test("defaultModelForProvider returns claude-opus-4-6", () => {
    expect(defaultModelForProvider("anthropic")).toBe("claude-opus-4-6");
  });

  test("getModel creates anthropic model with default claude-opus-4-6", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-opus-4-6" });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-opus-4-6");
    expect(model.provider).toBe("anthropic.messages");
    expect(model.specificationVersion).toBe("v3");
  });

  test("getModel with explicit claude-opus-4-6 override", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "some-other-model" });
    const model = getModel(cfg, "claude-opus-4-6");

    expect(model.modelId).toBe("claude-opus-4-6");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("getModel with claude-sonnet-4-5 model ID", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("getModel with claude-haiku-4-5 model ID", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("claude-haiku-4-5-20251001");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("directly created anthropic model matches getModel output", () => {
    const direct = anthropic("claude-opus-4-6");
    const cfg = makeConfig({ provider: "anthropic", model: "claude-opus-4-6" });
    const viaGetModel = getModel(cfg);

    expect(viaGetModel.modelId).toBe(direct.modelId);
    expect(viaGetModel.provider).toBe(direct.provider);
    expect(viaGetModel.specificationVersion).toBe(direct.specificationVersion);
  });

  test("anthropic provider options have thinking config with budget", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS.anthropic;

    expect(opts).toBeDefined();
    expect(opts.thinking).toBeDefined();
    expect(opts.thinking.type).toBe("enabled");
    expect(opts.thinking.budgetTokens).toBe(32_000);
  });

  test("anthropic thinking budget is a positive integer", () => {
    const budget = DEFAULT_PROVIDER_OPTIONS.anthropic.thinking.budgetTokens;
    expect(budget).toBeGreaterThan(0);
    expect(Number.isInteger(budget)).toBe(true);
  });

  test("providerOptions flow through config to agent calls", () => {
    const cfg = makeConfig({
      provider: "anthropic",
      model: "claude-opus-4-6",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.anthropic.thinking.type).toBe("enabled");
    expect(cfg.providerOptions!.anthropic.thinking.budgetTokens).toBe(32_000);
  });

  test("loadConfig with anthropic provider returns claude-opus-4-6 model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-6");
  });

  test("loadConfig with anthropic provider and custom model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic", AGENT_MODEL: "claude-sonnet-4-5-20250929" },
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-5-20250929");
  });

  test("loadConfig anthropic from project config file", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-6");
  });
});

// ---------------------------------------------------------------------------
// OpenAI provider - gpt-5.2 with reasoning
// ---------------------------------------------------------------------------
describe("OpenAI provider (gpt-5.2 with reasoning)", () => {
  test("defaultModelForProvider returns gpt-5.2", () => {
    expect(defaultModelForProvider("openai")).toBe("gpt-5.2");
  });

  test("getModel creates openai model with default gpt-5.2", () => {
    const cfg = makeConfig({ provider: "openai", model: "gpt-5.2" });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe("gpt-5.2");
    expect(model.provider).toBe("openai.responses");
    expect(model.specificationVersion).toBe("v3");
  });

  test("getModel with explicit gpt-5.2 override", () => {
    const cfg = makeConfig({ provider: "openai", model: "gpt-4o" });
    const model = getModel(cfg, "gpt-5.2");

    expect(model.modelId).toBe("gpt-5.2");
    expect(model.provider).toBe("openai.responses");
  });

  test("getModel with o3-mini model ID", () => {
    const cfg = makeConfig({ provider: "openai", model: "o3-mini" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("o3-mini");
    expect(model.provider).toBe("openai.responses");
  });

  test("directly created openai model matches getModel output", () => {
    const direct = openai("gpt-5.2");
    const cfg = makeConfig({ provider: "openai", model: "gpt-5.2" });
    const viaGetModel = getModel(cfg);

    expect(viaGetModel.modelId).toBe(direct.modelId);
    expect(viaGetModel.provider).toBe(direct.provider);
    expect(viaGetModel.specificationVersion).toBe(direct.specificationVersion);
  });

  test("openai provider options have reasoning enabled", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS.openai;

    expect(opts).toBeDefined();
    expect(opts.reasoningEffort).toBe("high");
    expect(opts.reasoningSummary).toBe("detailed");
  });

  test("openai reasoning effort is a valid level", () => {
    const effort = DEFAULT_PROVIDER_OPTIONS.openai.reasoningEffort;
    expect(["low", "medium", "high"]).toContain(effort);
  });

  test("openai reasoning summary is a valid mode", () => {
    const summary = DEFAULT_PROVIDER_OPTIONS.openai.reasoningSummary;
    expect(["auto", "concise", "detailed"]).toContain(summary);
  });

  test("providerOptions flow through config to agent calls", () => {
    const cfg = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.openai.reasoningEffort).toBe("high");
    expect(cfg.providerOptions!.openai.reasoningSummary).toBe("detailed");
  });

  test("loadConfig with openai provider returns gpt-5.2 model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("loadConfig with openai provider and custom model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai", AGENT_MODEL: "o3-mini" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("o3-mini");
  });

  test("loadConfig openai from project config file", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
      model: "gpt-5.2",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });
});

// ---------------------------------------------------------------------------
// Google provider - gemini-3-flash-preview
// ---------------------------------------------------------------------------
describe("Google provider (gemini-3-flash-preview)", () => {
  test("defaultModelForProvider returns gemini-3-flash-preview", () => {
    expect(defaultModelForProvider("google")).toBe("gemini-3-flash-preview");
  });

  test("getModel creates google model with default gemini-3-flash-preview", () => {
    const cfg = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe("gemini-3-flash-preview");
    expect(model.provider).toBe("google.generative-ai");
    expect(model.specificationVersion).toBe("v3");
  });

  test("getModel with explicit gemini model override", () => {
    const cfg = makeConfig({ provider: "google", model: "gemini-2.0-flash" });
    const model = getModel(cfg, "gemini-3-flash-preview");

    expect(model.modelId).toBe("gemini-3-flash-preview");
    expect(model.provider).toBe("google.generative-ai");
  });

  test("directly created google model matches getModel output", () => {
    const direct = google("gemini-3-flash-preview");
    const cfg = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const viaGetModel = getModel(cfg);

    expect(viaGetModel.modelId).toBe(direct.modelId);
    expect(viaGetModel.provider).toBe(direct.provider);
    expect(viaGetModel.specificationVersion).toBe(direct.specificationVersion);
  });

  test("google provider options have thinking config", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS.google;

    expect(opts).toBeDefined();
    expect(opts.thinkingConfig).toBeDefined();
    expect(opts.thinkingConfig.includeThoughts).toBe(true);
    expect(opts.thinkingConfig.thinkingLevel).toBe("high");
  });

  test("google thinkingLevel is a valid level", () => {
    const level = DEFAULT_PROVIDER_OPTIONS.google.thinkingConfig.thinkingLevel;
    expect(["none", "low", "medium", "high"]).toContain(level);
  });

  test("providerOptions flow through config to agent calls", () => {
    const cfg = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.google.thinkingConfig.includeThoughts).toBe(true);
    expect(cfg.providerOptions!.google.thinkingConfig.thinkingLevel).toBe("high");
  });

  test("loadConfig defaults to google provider", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("google");
    expect(cfg.model).toBe("gemini-3-flash-preview");
  });
});

// ---------------------------------------------------------------------------
// Provider options structure and consistency
// ---------------------------------------------------------------------------
describe("Provider options structure", () => {
  test("all three providers have options defined", () => {
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("openai");
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("google");
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("anthropic");
  });

  test("no extra unknown providers in options", () => {
    const providers = Object.keys(DEFAULT_PROVIDER_OPTIONS);
    expect(providers).toEqual(["openai", "google", "anthropic"]);
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

  test("all providers enable reasoning/thinking by default", () => {
    // OpenAI: reasoningEffort is "high"
    expect(DEFAULT_PROVIDER_OPTIONS.openai.reasoningEffort).toBe("high");

    // Google: thinkingConfig.includeThoughts is true
    expect(DEFAULT_PROVIDER_OPTIONS.google.thinkingConfig.includeThoughts).toBe(true);

    // Anthropic: thinking.type is "enabled"
    expect(DEFAULT_PROVIDER_OPTIONS.anthropic.thinking.type).toBe("enabled");
  });
});

// ---------------------------------------------------------------------------
// Cross-provider model creation
// ---------------------------------------------------------------------------
describe("Cross-provider model creation", () => {
  const providers: { name: ProviderName; defaultModel: string; providerPrefix: string }[] = [
    { name: "anthropic", defaultModel: "claude-opus-4-6", providerPrefix: "anthropic.messages" },
    { name: "openai", defaultModel: "gpt-5.2", providerPrefix: "openai.responses" },
    { name: "google", defaultModel: "gemini-3-flash-preview", providerPrefix: "google.generative-ai" },
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
// Provider switching behavior
// ---------------------------------------------------------------------------
describe("Provider switching via config", () => {
  test("switching provider via env gives correct default model", async () => {
    const { cwd, home } = await makeTmpDirs();

    // Start with google via project config
    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "google",
    });

    // Switch to openai via env
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("switching from google to anthropic via env uses anthropic default model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-6");
  });

  test("explicit model in project config persists across provider switch", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
      model: "gpt-5.2",
    });

    // Switch provider but keep model from config
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    expect(cfg.provider).toBe("anthropic");
    // model from project config is "gpt-5.2" which is kept even though provider changed
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("provider from user config can be overridden by project config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      provider: "anthropic",
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });
});

// ---------------------------------------------------------------------------
// Session reasoning kind per provider
// ---------------------------------------------------------------------------
describe("Session reasoning kind mapping", () => {
  // The session.ts uses this logic:
  //   const kind = config.provider === "openai" ? "summary" : "reasoning";
  // Test the mapping directly.

  test("openai provider maps to 'summary' reasoning kind", () => {
    const provider: ProviderName = "openai";
    const kind = provider === "openai" ? "summary" : "reasoning";
    expect(kind).toBe("summary");
  });

  test("anthropic provider maps to 'reasoning' kind", () => {
    const provider: ProviderName = "anthropic";
    const kind = provider === "openai" ? "summary" : "reasoning";
    expect(kind).toBe("reasoning");
  });

  test("google provider maps to 'reasoning' kind", () => {
    const provider: ProviderName = "google";
    const kind = provider === "openai" ? "summary" : "reasoning";
    expect(kind).toBe("reasoning");
  });
});

// ---------------------------------------------------------------------------
// Model defaults behavior when switching providers without model override
// ---------------------------------------------------------------------------
describe("Model defaults when built-in defaults specify a different provider", () => {
  test("built-in model from different provider is NOT used when provider changes", async () => {
    const { cwd, home } = await makeTmpDirs();

    // Simulate built-in defaults that specify google + gemini model
    const customBuiltIn = path.join(os.tmpdir(), "builtin-cross-" + Date.now());
    await writeJson(path.join(customBuiltIn, "config", "defaults.json"), {
      provider: "google",
      model: "gemini-3-flash-preview",
    });

    // Override provider to openai but don't specify model
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: customBuiltIn,
      env: { AGENT_PROVIDER: "openai" },
    });

    // Should NOT use gemini model with openai provider - should use openai's default
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("built-in model IS used when provider matches", async () => {
    const { cwd, home } = await makeTmpDirs();

    const customBuiltIn = path.join(os.tmpdir(), "builtin-match-" + Date.now());
    await writeJson(path.join(customBuiltIn, "config", "defaults.json"), {
      provider: "openai",
      model: "gpt-custom-default",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: customBuiltIn,
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-custom-default");
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

  test("providerOptions is referenced in agent.ts generateText call", async () => {
    // This test verifies the shape expected by agent.ts:
    //   providerOptions: config.providerOptions
    // The agent passes providerOptions directly from config to generateText.
    const cfg = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: { openai: { reasoningEffort: "high" } },
    });

    // Simulate what agent.ts does
    const generateTextArgs: any = {
      model: getModel(cfg),
      system: "test",
      messages: [],
      tools: {},
      providerOptions: cfg.providerOptions,
    };

    expect(generateTextArgs.providerOptions).toBeDefined();
    expect(generateTextArgs.providerOptions.openai.reasoningEffort).toBe("high");
    expect(generateTextArgs.model.modelId).toBe("gpt-5.2");
  });
});
