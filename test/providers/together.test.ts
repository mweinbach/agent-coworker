import path from "node:path";
import { describe, expect, test } from "bun:test";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { makeConfig, makeTmpDirs, repoRoot, writeJson } from "./helpers";

describe("Together AI provider", () => {
  test("defaultModelForProvider returns Kimi K2.5", () => {
    expect(defaultModelForProvider("together")).toBe("moonshotai/Kimi-K2.5");
  });

  test("getModel creates Together AI model with default Kimi K2.5", () => {
    const cfg = makeConfig({
      provider: "together",
      model: "moonshotai/Kimi-K2.5",
      subAgentModel: "moonshotai/Kimi-K2.5",
    });
    const model = getModel(cfg);

    expect(model.modelId).toBe("moonshotai/Kimi-K2.5");
    expect(model.provider).toBe("together.completions");
    expect(model.specificationVersion).toBe("v3");
  });

  test("loadConfig with together provider returns default together model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "together" },
    });

    expect(cfg.provider).toBe("together");
    expect(cfg.model).toBe("moonshotai/Kimi-K2.5");
    expect(cfg.runtime).toBe("pi");
  });

  test("loadConfig accepts a supported non-default together model", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "together",
      model: "Qwen/Qwen3.5-397B-A17B",
      subAgentModel: "Qwen/Qwen3.5-397B-A17B",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("together");
    expect(cfg.model).toBe("Qwen/Qwen3.5-397B-A17B");
    expect(cfg.runtime).toBe("pi");
  });
});
