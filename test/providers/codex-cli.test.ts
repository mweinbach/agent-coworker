import { describe, expect, test } from "bun:test";

import { codexCli } from "ai-sdk-provider-codex-cli";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
import { makeConfig, makeTmpDirs, repoRoot } from "./helpers";

const DEFAULT_CODEX_MODEL = PROVIDER_MODEL_CATALOG["codex-cli"].defaultModel;

// ---------------------------------------------------------------------------
// Codex CLI provider (OAuth/API key via Codex CLI)
// ---------------------------------------------------------------------------
describe(`Codex CLI provider (${DEFAULT_CODEX_MODEL})`, () => {
  test(`defaultModelForProvider returns ${DEFAULT_CODEX_MODEL}`, () => {
    expect(defaultModelForProvider("codex-cli")).toBe(DEFAULT_CODEX_MODEL);
  });

  test(`getModel creates codex-cli model with default ${DEFAULT_CODEX_MODEL}`, () => {
    const cfg = makeConfig({ provider: "codex-cli", model: DEFAULT_CODEX_MODEL });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe(DEFAULT_CODEX_MODEL);
    expect(model.provider).toBe("codex-cli");
    expect(model.specificationVersion).toBe("v3");
  });

  test("directly created codex-cli model matches getModel output", () => {
    const direct = codexCli(DEFAULT_CODEX_MODEL);
    const cfg = makeConfig({ provider: "codex-cli", model: DEFAULT_CODEX_MODEL });
    const viaGetModel = getModel(cfg);

    expect(viaGetModel.modelId).toBe(direct.modelId);
    expect(viaGetModel.provider).toBe(direct.provider);
    expect(viaGetModel.specificationVersion).toBe(direct.specificationVersion);
  });

  test(`loadConfig with codex-cli provider returns ${DEFAULT_CODEX_MODEL} model`, async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "codex-cli" },
    });

    expect(cfg.provider).toBe("codex-cli");
    expect(cfg.model).toBe(DEFAULT_CODEX_MODEL);
  });
});
