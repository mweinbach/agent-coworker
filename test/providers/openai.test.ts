import { describe, expect, test } from "bun:test";
import path from "node:path";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot, writeJson } from "./helpers";

// ---------------------------------------------------------------------------
// OpenAI provider - gpt-5.2 with reasoning
// ---------------------------------------------------------------------------
describe("OpenAI provider (gpt-5.2 with reasoning)", () => {
  test("defaultModelForProvider returns gpt-5.2", () => {
    expect(defaultModelForProvider("openai")).toBe("gpt-5.2");
  });

  test("getModel creates openai model with default gpt-5.2", () => {
    const cfg = makeConfig({ provider: "openai", model: "gpt-5.2" });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe("gpt-5.2");
    expect(model.provider).toBe("openai.responses");
    expect(model.specificationVersion).toBe("v3");
  });

  test("getModel with explicit gpt-5.2 override", () => {
    const cfg = makeConfig({ provider: "openai", model: "gpt-4o" });
    const model = getModel(cfg, "gpt-5.2");

    expect(model.modelId).toBe("gpt-5.2");
    expect(model.provider).toBe("openai.responses");
  });

  test("getModel with o3-mini model ID", () => {
    const cfg = makeConfig({ provider: "openai", model: "o3-mini" });
    const model = getModel(cfg);

    expect(model.modelId).toBe("o3-mini");
    expect(model.provider).toBe("openai.responses");
  });

  test("getModel exposes stable adapter shape", async () => {
    const cfg = makeConfig({ provider: "openai", model: "gpt-5.2" });
    const viaGetModel = getModel(cfg) as any;
    const headers = await viaGetModel.config.headers();

    expect(viaGetModel.modelId).toBe("gpt-5.2");
    expect(viaGetModel.provider).toBe("openai.responses");
    expect(viaGetModel.specificationVersion).toBe("v3");
    expect(typeof headers).toBe("object");
  });

  test("openai provider options have reasoning enabled", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS.openai;

    expect(opts).toBeDefined();
    expect(opts.reasoningEffort).toBe("high");
    expect(opts.reasoningSummary).toBe("detailed");
  });

  test("openai reasoning effort is a valid level", () => {
    const effort = DEFAULT_PROVIDER_OPTIONS.openai.reasoningEffort;
    expect(["low", "medium", "high"]).toContain(effort);
  });

  test("openai reasoning summary is a valid mode", () => {
    const summary = DEFAULT_PROVIDER_OPTIONS.openai.reasoningSummary;
    expect(["auto", "concise", "detailed"]).toContain(summary);
  });

  test("providerOptions flow through config to agent calls", () => {
    const cfg = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.openai.reasoningEffort).toBe("high");
    expect(cfg.providerOptions!.openai.reasoningSummary).toBe("detailed");
  });

  test("loadConfig with openai provider returns gpt-5.2 model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("loadConfig with openai provider and custom model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai", AGENT_MODEL: "o3-mini" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("o3-mini");
  });

  test("loadConfig openai from project config file", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
      model: "gpt-5.2",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });
});
