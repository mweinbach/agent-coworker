import path from "node:path";
import { describe, expect, test } from "bun:test";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { makeConfig, makeTmpDirs, repoRoot, writeJson } from "./helpers";

describe("Fireworks AI provider", () => {
  test("defaultModelForProvider returns GLM-5", () => {
    expect(defaultModelForProvider("fireworks")).toBe("accounts/fireworks/models/glm-5");
  });

  test("getModel creates Fireworks model with default GLM-5", () => {
    const cfg = makeConfig({
      provider: "fireworks",
      model: "accounts/fireworks/models/glm-5",
      preferredChildModel: "accounts/fireworks/models/glm-5",
    });
    const model = getModel(cfg);

    expect(model.modelId).toBe("accounts/fireworks/models/glm-5");
    expect(model.provider).toBe("fireworks.completions");
    expect(model.specificationVersion).toBe("v3");
  });

  test("loadConfig with fireworks provider returns default fireworks model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "fireworks" },
    });

    expect(cfg.provider).toBe("fireworks");
    expect(cfg.model).toBe("accounts/fireworks/models/glm-5");
    expect(cfg.runtime).toBe("pi");
  });

  test("loadConfig accepts a supported non-default fireworks model", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "fireworks",
      model: "accounts/fireworks/models/kimi-k2p5",
      preferredChildModel: "accounts/fireworks/models/kimi-k2p5",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("fireworks");
    expect(cfg.model).toBe("accounts/fireworks/models/kimi-k2p5");
    expect(cfg.runtime).toBe("pi");
  });
});
