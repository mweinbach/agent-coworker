import { describe, expect, test } from "bun:test";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot } from "./helpers";

const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";

describe(`Codex provider (${DEFAULT_CODEX_MODEL})`, () => {
  test(`defaultModelForProvider returns ${DEFAULT_CODEX_MODEL}`, () => {
    expect(defaultModelForProvider("codex-cli")).toBe(DEFAULT_CODEX_MODEL);
  });

  test(`getModel creates codex model with default ${DEFAULT_CODEX_MODEL}`, () => {
    const cfg = makeConfig({ provider: "codex-cli", model: DEFAULT_CODEX_MODEL });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe(DEFAULT_CODEX_MODEL);
    expect(model.provider).toBe("codex-cli.responses");
    expect(model.specificationVersion).toBe("v3");
  });

  test("getModel exposes stable adapter shape", async () => {
    const cfg = makeConfig({ provider: "codex-cli", model: DEFAULT_CODEX_MODEL });
    const viaGetModel = getModel(cfg, DEFAULT_CODEX_MODEL) as any;
    const headers = await viaGetModel.config.headers();

    expect(viaGetModel.modelId).toBe(DEFAULT_CODEX_MODEL);
    expect(viaGetModel.provider).toBe("codex-cli.responses");
    expect(viaGetModel.specificationVersion).toBe("v3");
    expect(typeof headers).toBe("object");
  });

  test("codex provider options are configured", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS["codex-cli"];
    expect(opts).toBeDefined();
    expect(opts.reasoningEffort).toBe("high");
    expect(opts.reasoningSummary).toBe("detailed");
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
