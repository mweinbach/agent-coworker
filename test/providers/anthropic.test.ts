import { describe, expect, test } from "bun:test";

import path from "node:path";

import { defaultModelForProvider, loadConfig } from "../../src/config";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig, makeTmpDirs, repoRoot, writeJson } from "./helpers";

// ---------------------------------------------------------------------------
// Anthropic provider - claude-opus-4-8
// ---------------------------------------------------------------------------
describe("Anthropic provider (claude-opus-4-8)", () => {
  test("defaultModelForProvider returns claude-opus-4-8", () => {
    expect(defaultModelForProvider("anthropic")).toBe("claude-opus-4-8");
  });

  test("anthropic provider options use adaptive thinking with high effort", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS.anthropic;

    expect(opts).toBeDefined();
    expect(opts.thinking).toBeDefined();
    expect(opts.thinking.type).toBe("adaptive");
    expect(opts.thinking.budgetTokens).toBeUndefined();
    expect(opts.effort).toBe("high");
  });

  test("providerOptions flow through config to agent calls", () => {
    const cfg = makeConfig({
      provider: "anthropic",
      model: "claude-opus-4-8",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.anthropic.thinking.type).toBe("adaptive");
    expect(cfg.providerOptions!.anthropic.effort).toBe("high");
  });

  test("loadConfig with anthropic provider returns claude-opus-4-8 model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-8");
  });

  test("loadConfig with anthropic provider and supported non-default model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic", AGENT_MODEL: "claude-sonnet-4-5" },
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-5");
  });

  test("loadConfig anthropic from project config file", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-6");
  });
});
