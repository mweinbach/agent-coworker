import { describe, expect, test } from "bun:test";
import path from "node:path";

import { defaultModelForProvider, loadConfig } from "../../src/config";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot, writeJson } from "./helpers";

// ---------------------------------------------------------------------------
// OpenAI provider - gpt-5.4 with reasoning
// ---------------------------------------------------------------------------
describe("OpenAI provider (gpt-5.4 with reasoning)", () => {
  test("defaultModelForProvider returns gpt-5.4", () => {
    expect(defaultModelForProvider("openai")).toBe("gpt-5.4");
  });

  test("openai provider options have reasoning enabled", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS.openai;

    expect(opts).toBeDefined();
    expect(opts.reasoningEffort).toBe("high");
    expect(opts.reasoningSummary).toBe("detailed");
    expect(opts.textVerbosity).toBe("medium");
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
      model: "gpt-5.4",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.openai.reasoningEffort).toBe("high");
    expect(cfg.providerOptions!.openai.reasoningSummary).toBe("detailed");
    expect(cfg.providerOptions!.openai.textVerbosity).toBe("medium");
  });

  test("loadConfig with openai provider returns gpt-5.4 model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.4");
  });

  test("loadConfig with openai provider and supported non-default model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai", AGENT_MODEL: "gpt-5.2-pro" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2-pro");
  });

  test("loadConfig openai from project config file", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "openai",
      model: "gpt-5.4",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.4");
  });
});
