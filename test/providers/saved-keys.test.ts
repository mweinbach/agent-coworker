import { describe, expect, test } from "bun:test";
import path from "node:path";

import { getModel } from "../../src/config";
import { makeConfig, makeTmpDirs, withEnv, writeJson } from "./helpers";

// ---------------------------------------------------------------------------
// Saved API keys in ~/.cowork/auth should override .env keys
// ---------------------------------------------------------------------------
describe("Saved API key precedence (~/.cowork/auth)", () => {
  test("openai saved key overrides OPENAI_API_KEY", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-openai-key";
    const envKey = "env-openai-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        openai: {
          service: "openai",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("OPENAI_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "openai",
        model: "gpt-5.2",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Bearer ${savedKey}`);
    });
  });

  test("google saved key overrides GOOGLE_GENERATIVE_AI_API_KEY", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-google-key";
    const envKey = "env-google-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        google: {
          service: "google",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "google",
        model: "gemini-3-flash-preview",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers["x-goog-api-key"]).toBe(savedKey);
    });
  });

  test("anthropic saved key overrides ANTHROPIC_API_KEY", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-anthropic-key";
    const envKey = "env-anthropic-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        anthropic: {
          service: "anthropic",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("ANTHROPIC_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "anthropic",
        model: "claude-opus-4-6",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers["x-api-key"]).toBe(savedKey);
    });
  });

  test("codex-cli provider can reuse saved openai key", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-openai-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        openai: {
          service: "openai",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const cfg = makeConfig({
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      userAgentDir: path.join(home, ".agent"),
    });

    const model = getModel(cfg) as any;
    expect(model.settings?.env?.OPENAI_API_KEY).toBe(savedKey);
  });

  test("claude-code provider can reuse saved anthropic key", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-anthropic-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        anthropic: {
          service: "anthropic",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const cfg = makeConfig({
      provider: "claude-code",
      model: "sonnet",
      userAgentDir: path.join(home, ".agent"),
    });

    const model = getModel(cfg) as any;
    expect(model.settings?.env?.ANTHROPIC_API_KEY).toBe(savedKey);
  });

  test("falls back to env key when saved entry has no api key", async () => {
    const { home } = await makeTmpDirs();
    const envKey = "env-openai-fallback";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        openai: {
          service: "openai",
          mode: "oauth_pending",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("OPENAI_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "openai",
        model: "gpt-5.2",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Bearer ${envKey}`);
    });
  });
});
