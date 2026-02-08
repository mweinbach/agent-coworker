import { describe, expect, test } from "bun:test";

import { codexCli } from "ai-sdk-provider-codex-cli";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { makeConfig, makeTmpDirs, repoRoot } from "./helpers";

// ---------------------------------------------------------------------------
// Codex CLI provider - gpt-5.2-codex (OAuth/API key via Codex CLI)
// ---------------------------------------------------------------------------
describe("Codex CLI provider (gpt-5.2-codex)", () => {
  test("defaultModelForProvider returns gpt-5.2-codex", () => {
    expect(defaultModelForProvider("codex-cli")).toBe("gpt-5.2-codex");
  });

  test("getModel creates codex-cli model with default gpt-5.2-codex", () => {
    const cfg = makeConfig({ provider: "codex-cli", model: "gpt-5.2-codex" });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe("gpt-5.2-codex");
    expect(model.provider).toBe("codex-cli");
    expect(model.specificationVersion).toBe("v3");
  });

  test("directly created codex-cli model matches getModel output", () => {
    const direct = codexCli("gpt-5.2-codex");
    const cfg = makeConfig({ provider: "codex-cli", model: "gpt-5.2-codex" });
    const viaGetModel = getModel(cfg);

    expect(viaGetModel.modelId).toBe(direct.modelId);
    expect(viaGetModel.provider).toBe(direct.provider);
    expect(viaGetModel.specificationVersion).toBe(direct.specificationVersion);
  });

  test("loadConfig with codex-cli provider returns gpt-5.2-codex model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "codex-cli" },
    });

    expect(cfg.provider).toBe("codex-cli");
    expect(cfg.model).toBe("gpt-5.2-codex");
  });
});
