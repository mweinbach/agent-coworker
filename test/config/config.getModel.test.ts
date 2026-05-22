import { describe, expect, mock, test } from "bun:test";
import { defaultModelForProvider, getModel } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
import {
  fs,
  loadConfig,
  makeTmpDirs,
  os,
  path,
  repoRoot,
  withEnv,
  withMockedFetch,
  writeJson,
} from "./config.harness";

describe("getModel", () => {
  test("returns google() model for google provider", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google" },
    });

    const model = getModel(cfg);
    expect(model).toBeDefined();
  });

  test("returns openai() model for openai provider", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    const model = getModel(cfg);
    expect(model).toBeDefined();
  });

  test("returns anthropic() model for anthropic provider", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    const model = getModel(cfg);
    expect(model).toBeDefined();
  });

  test("custom model ID passed through overrides config model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google" },
    });

    expect(() => getModel(cfg, "gemini-custom-override")).toThrow(
      'Unsupported model override "gemini-custom-override" for provider google',
    );
  });

  test("invalid AGENT_MODEL falls back to provider default when no override ID is provided", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google", AGENT_MODEL: "gemini-specific" },
    });

    expect(cfg.model).toBe(defaultModelForProvider("google"));
    expect(cfg.preferredChildModel).toBe(defaultModelForProvider("google"));
  });

  test("OpenAI-looking AGENT_MODEL on anthropic warns with provider guidance and falls back", async () => {
    const { cwd, home } = await makeTmpDirs();
    const realWarn = console.warn;
    const warn = mock(() => {});
    console.warn = warn as typeof console.warn;

    try {
      const cfg = await loadConfig({
        cwd,
        homedir: home,
        builtInDir: repoRoot(),
        env: { AGENT_PROVIDER: "anthropic", AGENT_MODEL: "gpt-5.4(xhigh)" },
      });

      expect(cfg.provider).toBe("anthropic");
      expect(cfg.model).toBe(defaultModelForProvider("anthropic"));
      const warnings = warn.mock.calls.map(([message]) => String(message));
      expect(
        warnings.some((message) =>
          message.includes('Ignoring unsupported model "gpt-5.4(xhigh)" for provider anthropic'),
        ),
      ).toBe(true);
      expect(warnings.some((message) => message.includes("looks like an OpenAI model"))).toBe(true);
      expect(warnings.some((message) => message.includes("use provider openai instead"))).toBe(
        true,
      );
    } finally {
      console.warn = realWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// defaultModelForProvider
// ---------------------------------------------------------------------------
