import { describe, expect, test } from "bun:test";

import { createGeminiProvider } from "ai-sdk-provider-gemini-cli";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { makeConfig, makeTmpDirs, repoRoot } from "./helpers";

// ---------------------------------------------------------------------------
// Gemini CLI provider - gemini-3-flash-preview (OAuth/API key via CLI provider)
// ---------------------------------------------------------------------------
describe("Gemini CLI provider (gemini-3-flash-preview)", () => {
  test("defaultModelForProvider returns gemini-3-flash-preview", () => {
    expect(defaultModelForProvider("gemini-cli")).toBe("gemini-3-flash-preview");
  });

  test("getModel creates gemini-cli model with default gemini-3-flash-preview", () => {
    const cfg = makeConfig({ provider: "gemini-cli", model: "gemini-3-flash-preview" });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe("gemini-3-flash-preview");
    expect(model.provider).toBe("gemini-cli-core");
    expect(model.specificationVersion).toBe("v3");
  });

  test("getModel disables Gemini thought parts by default for tool-call loops", () => {
    const cfg = makeConfig({ provider: "gemini-cli", model: "gemini-3-flash-preview" });
    const model = getModel(cfg) as any;

    expect(model.settings?.thinkingConfig?.includeThoughts).toBe(false);
    expect(model.settings?.thinkingConfig?.thinkingLevel).toBe("minimal");
  });

  test("getModel allows gemini-cli thinking overrides via providerOptions", () => {
    const cfg = makeConfig({
      provider: "gemini-cli",
      model: "gemini-3-flash-preview",
      providerOptions: {
        "gemini-cli-core": {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "high",
          },
        },
      },
    });
    const model = getModel(cfg) as any;

    expect(model.settings?.thinkingConfig?.includeThoughts).toBe(true);
    expect(model.settings?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("directly created gemini-cli model matches getModel output", () => {
    const direct = createGeminiProvider({ authType: "oauth-personal" })("gemini-3-flash-preview");
    const cfg = makeConfig({ provider: "gemini-cli", model: "gemini-3-flash-preview" });
    const viaGetModel = getModel(cfg);

    expect(viaGetModel.modelId).toBe(direct.modelId);
    expect(viaGetModel.provider).toBe(direct.provider);
    expect(viaGetModel.specificationVersion).toBe(direct.specificationVersion);
  });

  test("loadConfig with gemini-cli provider returns gemini-3-flash-preview model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "gemini-cli" },
    });

    expect(cfg.provider).toBe("gemini-cli");
    expect(cfg.model).toBe("gemini-3-flash-preview");
  });
});
