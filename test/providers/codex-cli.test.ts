import { describe, expect, test } from "bun:test";

import { defaultModelForProvider, loadConfig } from "../../src/config";
import { defaultSupportedModel, providerOptionsDefaultsForModel } from "../../src/models/registry";
import { DEFAULT_PROVIDER_OPTIONS, makeTmpDirs, repoRoot } from "./helpers";

const DEFAULT_CODEX_MODEL = defaultSupportedModel("codex-cli").id;
const DEFAULT_CODEX_PROVIDER_OPTIONS = providerOptionsDefaultsForModel(
  "codex-cli",
  DEFAULT_CODEX_MODEL,
);

describe(`Codex provider (${DEFAULT_CODEX_MODEL})`, () => {
  test(`defaultModelForProvider returns ${DEFAULT_CODEX_MODEL}`, () => {
    expect(defaultModelForProvider("codex-cli")).toBe(DEFAULT_CODEX_MODEL);
  });

  test("codex provider options are configured", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS["codex-cli"];
    expect(opts).toBeDefined();
    expect(opts).toEqual(DEFAULT_CODEX_PROVIDER_OPTIONS);
    expect(opts.reasoningEffort).toBe("high");
    expect(opts.reasoningSummary).toBe("detailed");
    expect(opts.textVerbosity).toBe("medium");
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
    expect(cfg.providerOptions?.["codex-cli"]).toEqual(DEFAULT_CODEX_PROVIDER_OPTIONS);
  });

  test("Spark omits the unsupported reasoning summary default", () => {
    const opts = providerOptionsDefaultsForModel("codex-cli", "gpt-5.3-codex-spark");

    expect(opts.reasoningEffort).toBe("high");
    expect(opts.reasoningSummary).toBeUndefined();
    expect(opts.textVerbosity).toBe("medium");
  });
});
