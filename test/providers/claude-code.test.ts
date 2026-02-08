import { describe, expect, test } from "bun:test";

import { claudeCode } from "ai-sdk-provider-claude-code";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { makeConfig, makeTmpDirs, repoRoot } from "./helpers";

// ---------------------------------------------------------------------------
// Claude Code provider - sonnet (OAuth/API key via Claude Code)
// ---------------------------------------------------------------------------
describe("Claude Code provider (sonnet)", () => {
  test("defaultModelForProvider returns sonnet", () => {
    expect(defaultModelForProvider("claude-code")).toBe("sonnet");
  });

  test("getModel creates claude-code model with default sonnet", () => {
    const cfg = makeConfig({ provider: "claude-code", model: "sonnet" });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe("sonnet");
    expect(model.provider).toBe("claude-code");
    expect(model.specificationVersion).toBe("v3");
  });

  test("directly created claude-code model matches getModel output", () => {
    const direct = claudeCode("sonnet");
    const cfg = makeConfig({ provider: "claude-code", model: "sonnet" });
    const viaGetModel = getModel(cfg);

    expect(viaGetModel.modelId).toBe(direct.modelId);
    expect(viaGetModel.provider).toBe(direct.provider);
    expect(viaGetModel.specificationVersion).toBe(direct.specificationVersion);
  });

  test("loadConfig with claude-code provider returns sonnet model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "claude-code" },
    });

    expect(cfg.provider).toBe("claude-code");
    expect(cfg.model).toBe("sonnet");
  });
});
