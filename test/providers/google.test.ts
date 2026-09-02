import { describe, expect, test } from "bun:test";

import { defaultModelForProvider, loadConfig } from "../../src/config";
import { normalizeModelIdForProvider } from "../../src/models/metadata";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot } from "./helpers";

// ---------------------------------------------------------------------------
// Google provider - gemini-3.1-pro-preview
// ---------------------------------------------------------------------------
describe("Google provider (gemini-3.1-pro-preview)", () => {
  test("defaultModelForProvider returns gemini-3.1-pro-preview", () => {
    expect(defaultModelForProvider("google")).toBe("gemini-3.1-pro-preview");
  });

  test("catalog includes Gemini 3 preview models", () => {
    expect(PROVIDER_MODEL_CATALOG.google.availableModels).toContain("gemini-3-flash-preview");
    expect(PROVIDER_MODEL_CATALOG.google.availableModels).toContain("gemini-3.1-pro-preview");
    expect(PROVIDER_MODEL_CATALOG.google.availableModels).toContain(
      "gemini-3.1-pro-preview-customtools",
    );
    expect(PROVIDER_MODEL_CATALOG.google.availableModels).toContain("gemini-3.1-flash-lite");
    expect(PROVIDER_MODEL_CATALOG.google.availableModels).not.toContain(
      "gemini-3.1-flash-lite-preview",
    );
  });

  test("google provider options have thinking config", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS.google;

    expect(opts).toBeDefined();
    expect(opts.thinkingConfig).toBeDefined();
    expect(opts.thinkingConfig.includeThoughts).toBe(true);
    expect(opts.thinkingConfig.thinkingLevel).toBeUndefined();
  });

  test("google default thinkingLevel is unset so Gemini can choose dynamically", () => {
    const level = DEFAULT_PROVIDER_OPTIONS.google.thinkingConfig.thinkingLevel;
    expect(level).toBeUndefined();
  });

  test("providerOptions flow through config to agent calls", () => {
    const cfg = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.google.thinkingConfig.includeThoughts).toBe(true);
    expect(cfg.providerOptions!.google.thinkingConfig.thinkingLevel).toBeUndefined();
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
    expect(cfg.model).toBe("gemini-3.1-pro-preview");
  });

  test("legacy alias gemini-3-pro-preview normalizes to gemini-3.1-pro-preview-customtools", () => {
    const normalized = normalizeModelIdForProvider("google", "gemini-3-pro-preview");
    expect(normalized).toBe("gemini-3.1-pro-preview-customtools");
  });

  test("legacy alias gemini-3.1-flash-lite-preview normalizes to gemini-3.1-flash-lite", () => {
    const normalized = normalizeModelIdForProvider("google", "gemini-3.1-flash-lite-preview");
    expect(normalized).toBe("gemini-3.1-flash-lite");
  });
});
