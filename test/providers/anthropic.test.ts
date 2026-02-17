import { describe, expect, test } from "bun:test";

import path from "node:path";

import { anthropic } from "@ai-sdk/anthropic";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot, writeJson } from "./helpers";

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

  test("getModel maps claude-4-6-sonnet alias to Anthropic canonical model ID", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-4-6-sonnet" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("claude-sonnet-4-6");
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
