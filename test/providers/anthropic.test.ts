import { describe, expect, test } from "bun:test";

import path from "node:path";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot, writeJson } from "./helpers";

// ---------------------------------------------------------------------------
// Anthropic provider - claude-opus-4-8
// ---------------------------------------------------------------------------
describe("Anthropic provider (claude-opus-4-8)", () => {
  test("defaultModelForProvider returns claude-opus-4-8", () => {
    expect(defaultModelForProvider("anthropic")).toBe("claude-opus-4-8");
  });

  test("getModel creates anthropic model with default claude-opus-4-8", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-opus-4-8" });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-opus-4-8");
    expect(model.provider).toBe("anthropic.messages");
    expect(model.specificationVersion).toBe("v3");
  });

  test("getModel with explicit claude-opus-4-6 override", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-sonnet-4-5" });
    const model = getModel(cfg, "claude-opus-4-6");

    expect(model.modelId).toBe("claude-opus-4-6");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("getModel with claude-sonnet-4-5 model ID", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-sonnet-4-5" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("claude-sonnet-4-5");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("getModel maps claude-sonnet-4-6 alias to Anthropic canonical model ID", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("claude-sonnet-4-6");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("getModel with claude-haiku-4-5 model ID", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-haiku-4-5" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("claude-haiku-4-5");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("getModel with claude-opus-4-7 model ID", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-opus-4-7" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("claude-opus-4-7");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("getModel with claude-opus-4-8 model ID", () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-opus-4-8" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("claude-opus-4-8");
    expect(model.provider).toBe("anthropic.messages");
  });

  test("getModel exposes stable adapter shape", async () => {
    const cfg = makeConfig({ provider: "anthropic", model: "claude-opus-4-8" });
    const viaGetModel = getModel(cfg) as any;
    const headers = await viaGetModel.config.headers();

    expect(viaGetModel.modelId).toBe("claude-opus-4-8");
    expect(viaGetModel.provider).toBe("anthropic.messages");
    expect(viaGetModel.specificationVersion).toBe("v3");
    expect(typeof headers).toBe("object");
  });

  test("anthropic provider options use adaptive thinking with high effort", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS.anthropic;

    expect(opts).toBeDefined();
    expect(opts.thinking).toBeDefined();
    expect(opts.thinking.type).toBe("adaptive");
    expect(opts.thinking.budgetTokens).toBeUndefined();
    expect(opts.effort).toBe("high");
  });

  test("providerOptions flow through config to agent calls", () => {
    const cfg = makeConfig({
      provider: "anthropic",
      model: "claude-opus-4-8",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.anthropic.thinking.type).toBe("adaptive");
    expect(cfg.providerOptions!.anthropic.effort).toBe("high");
  });

  test("loadConfig with anthropic provider returns claude-opus-4-8 model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-8");
  });

  test("loadConfig with anthropic provider and supported non-default model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic", AGENT_MODEL: "claude-sonnet-4-5" },
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-5");
  });

  test("loadConfig anthropic from project config file", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
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
