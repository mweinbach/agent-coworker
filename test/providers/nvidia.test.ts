import path from "node:path";
import { describe, expect, test } from "bun:test";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { makeTmpDirs, repoRoot, writeJson } from "./helpers";

describe("NVIDIA provider", () => {
  test("defaultModelForProvider returns Nemotron 3 Super 120B A12B", () => {
    expect(defaultModelForProvider("nvidia")).toBe("nvidia/nemotron-3-super-120b-a12b");
  });

  test("getModel creates NVIDIA model with default Nemotron 3 Super 120B A12B", () => {
    const model = getModel({
      provider: "nvidia",
      runtime: "pi",
      model: "nvidia/nemotron-3-super-120b-a12b",
      subAgentModel: "nvidia/nemotron-3-super-120b-a12b",
      workingDirectory: "/tmp",
      outputDirectory: "/tmp/output",
      uploadsDirectory: "/tmp/uploads",
      userName: "",
      knowledgeCutoff: "unknown",
      projectAgentDir: "/tmp/.agent",
      userAgentDir: "/tmp/.agent-user",
      builtInDir: "/tmp/built-in",
      builtInConfigDir: "/tmp/built-in/config",
      skillsDirs: [],
      memoryDirs: [],
      configDirs: [],
    });

    expect(model.modelId).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(model.provider).toBe("nvidia.completions");
    expect(model.specificationVersion).toBe("v3");
  });

  test("loadConfig with nvidia provider returns default nvidia model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "nvidia" },
    });

    expect(cfg.provider).toBe("nvidia");
    expect(cfg.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(cfg.runtime).toBe("pi");
  });

  test("loadConfig accepts the supported nvidia model", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "nvidia",
      model: "nvidia/nemotron-3-super-120b-a12b",
      subAgentModel: "nvidia/nemotron-3-super-120b-a12b",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("nvidia");
    expect(cfg.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(cfg.runtime).toBe("pi");
  });
});
