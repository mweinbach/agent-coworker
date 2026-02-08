import { describe, expect, test } from "bun:test";

import { google } from "@ai-sdk/google";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot } from "./helpers";

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
