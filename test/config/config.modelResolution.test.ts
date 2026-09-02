import { describe, expect, mock, test } from "bun:test";
import { defaultModelForProvider } from "../../src/config";
import { resolveGoogleInteractionsModel } from "../../src/runtime/googleInteractionsModel";
import { resolveOpenAiResponsesModel } from "../../src/runtime/openaiResponsesModel";
import { resolvePiModel } from "../../src/runtime/pi/modelResolution";
import { makeRuntimeParams } from "../providers/helpers";
import { loadConfig, makeTmpDirs, repoRoot } from "./config.harness";

describe("configured runtime model resolution", () => {
  test("resolves Google Interactions model from loaded config", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google" },
    });

    const { model } = await resolveGoogleInteractionsModel(makeRuntimeParams(cfg));
    expect(model.id).toBe(cfg.model);
  });

  test("resolves OpenAI Responses model from loaded config", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    const { model } = await resolveOpenAiResponsesModel(makeRuntimeParams(cfg));
    expect(model.id).toBe(cfg.model);
    expect(model.api).toBe("openai-responses");
  });

  test("resolves Anthropic PI model from loaded config", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    const { model } = await resolvePiModel(makeRuntimeParams(cfg));
    expect(model.id).toBe(cfg.model);
    expect(model.api).toBe("anthropic-messages");
  });

  test("unknown Google model IDs retain dynamic discovery support", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google" },
    });

    const { model } = await resolveGoogleInteractionsModel(
      makeRuntimeParams({ ...cfg, model: "gemini-custom-override" }),
    );
    expect(model.id).toBe("gemini-custom-override");
  });

  test("model override registered to another provider is rejected with guidance", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google" },
    });

    await expect(
      resolveGoogleInteractionsModel(makeRuntimeParams({ ...cfg, model: "claude-sonnet-4-6" })),
    ).rejects.toThrow('Unsupported model "claude-sonnet-4-6" for provider google');
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
