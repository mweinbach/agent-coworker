import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config";
import { makeTmpDirs, repoRoot, writeJson } from "./helpers";

// ---------------------------------------------------------------------------
// Provider switching behavior
// ---------------------------------------------------------------------------
describe("Provider switching via config", () => {
  test("switching provider via env gives correct default model", async () => {
    const { cwd, home } = await makeTmpDirs();

    // Start with google via project config
    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "google",
    });

    // Switch to openai via env
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("switching from google to anthropic via env uses anthropic default model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-6");
  });

  test("explicit model in project config persists across provider switch", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
      model: "gpt-5.2",
    });

    // Switch provider but keep model from config
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    expect(cfg.provider).toBe("anthropic");
    // model from project config is "gpt-5.2" which is kept even though provider changed
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("provider from user config can be overridden by project config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      provider: "anthropic",
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
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

// ---------------------------------------------------------------------------
// Model defaults behavior when switching providers without model override
// ---------------------------------------------------------------------------
describe("Model defaults when built-in defaults specify a different provider", () => {
  test("built-in model from different provider is NOT used when provider changes", async () => {
    const { cwd, home } = await makeTmpDirs();

    // Simulate built-in defaults that specify google + gemini model
    const customBuiltIn = path.join(os.tmpdir(), "builtin-cross-" + Date.now());
    await writeJson(path.join(customBuiltIn, "config", "defaults.json"), {
      provider: "google",
      model: "gemini-3-flash-preview",
    });

    // Override provider to openai but don't specify model
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: customBuiltIn,
      env: { AGENT_PROVIDER: "openai" },
    });

    // Should NOT use gemini model with openai provider - should use openai's default
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("built-in model IS used when provider matches", async () => {
    const { cwd, home } = await makeTmpDirs();

    const customBuiltIn = path.join(os.tmpdir(), "builtin-match-" + Date.now());
    await writeJson(path.join(customBuiltIn, "config", "defaults.json"), {
      provider: "openai",
      model: "gpt-custom-default",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: customBuiltIn,
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-custom-default");
  });
});
