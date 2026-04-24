import { describe, expect, test } from "bun:test";
import path from "node:path";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { makeConfig, makeTmpDirs, repoRoot, writeJson } from "./helpers";

describe("Baseten provider", () => {
  test("defaultModelForProvider returns Kimi K2.5", () => {
    expect(defaultModelForProvider("baseten")).toBe("moonshotai/Kimi-K2.5");
  });

  test("getModel creates baseten model with default Kimi K2.5", () => {
    const cfg = makeConfig({
      provider: "baseten",
      model: "moonshotai/Kimi-K2.5",
      preferredChildModel: "moonshotai/Kimi-K2.5",
    });
    const model = getModel(cfg);

    expect(model.modelId).toBe("moonshotai/Kimi-K2.5");
    expect(model.provider).toBe("baseten.completions");
    expect(model.specificationVersion).toBe("v3");
  });

  test("loadConfig with baseten provider returns default baseten model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "baseten" },
    });

    expect(cfg.provider).toBe("baseten");
    expect(cfg.model).toBe("moonshotai/Kimi-K2.5");
    expect(cfg.runtime).toBe("pi");
  });

  test("loadConfig accepts a supported non-default baseten model", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "baseten",
      model: "nvidia/Nemotron-120B-A12B",
      preferredChildModel: "nvidia/Nemotron-120B-A12B",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("baseten");
    expect(cfg.model).toBe("nvidia/Nemotron-120B-A12B");
    expect(cfg.runtime).toBe("pi");
  });
});
