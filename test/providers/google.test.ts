import { describe, expect, test } from "bun:test";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot } from "./helpers";

// ---------------------------------------------------------------------------
// Google provider - gemini-3.1-pro-preview-customtools
// ---------------------------------------------------------------------------
describe("Google provider (gemini-3.1-pro-preview-customtools)", () => {
  test("defaultModelForProvider returns gemini-3.1-pro-preview-customtools", () => {
    expect(defaultModelForProvider("google")).toBe("gemini-3.1-pro-preview-customtools");
  });

  test("catalog includes gemini-3.1-pro-preview", () => {
    expect(PROVIDER_MODEL_CATALOG.google.availableModels).toContain("gemini-3.1-pro-preview");
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

  test("getModel exposes stable adapter shape", async () => {
    const cfg = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const viaGetModel = getModel(cfg) as any;
    const headers = await viaGetModel.config.headers();

    expect(viaGetModel.modelId).toBe("gemini-3-flash-preview");
    expect(viaGetModel.provider).toBe("google.generative-ai");
    expect(viaGetModel.specificationVersion).toBe("v3");
    expect(typeof headers).toBe("object");
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
    expect(cfg.model).toBe("gemini-3.1-pro-preview-customtools");
  });
});
