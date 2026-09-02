import { describe, expect, test } from "bun:test";
import path from "node:path";

import { defaultModelForProvider, loadConfig } from "../../src/config";
import { makeTmpDirs, repoRoot, writeJson } from "./helpers";

describe("Fireworks AI provider", () => {
  test("defaultModelForProvider returns Kimi K2.6", () => {
    expect(defaultModelForProvider("fireworks")).toBe("accounts/fireworks/models/kimi-k2p6");
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
    expect(cfg.model).toBe("accounts/fireworks/models/kimi-k2p6");
    expect(cfg.runtime).toBe("pi");
  });

  test("loadConfig accepts a supported non-default fireworks model", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "fireworks",
      model: "accounts/fireworks/models/glm-5p1",
      preferredChildModel: "accounts/fireworks/models/glm-5p1",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("fireworks");
    expect(cfg.model).toBe("accounts/fireworks/models/glm-5p1");
    expect(cfg.runtime).toBe("pi");
  });
});
