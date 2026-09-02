import { describe, expect, test } from "bun:test";
import path from "node:path";

import { defaultModelForProvider, loadConfig } from "../../src/config";
import { makeTmpDirs, repoRoot, writeJson } from "./helpers";

describe("NVIDIA provider", () => {
  test("defaultModelForProvider returns Nemotron 3 Super 120B A12B", () => {
    expect(defaultModelForProvider("nvidia")).toBe("nvidia/nemotron-3-super-120b-a12b");
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

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "nvidia",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredChildModel: "nvidia/nemotron-3-super-120b-a12b",
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
