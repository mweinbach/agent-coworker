import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
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

  test("baseten saved key overrides BASETEN_API_KEY", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-baseten-key";
    const envKey = "env-baseten-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        baseten: {
          service: "baseten",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("BASETEN_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "baseten",
        model: "moonshotai/Kimi-K2.5",
        subAgentModel: "moonshotai/Kimi-K2.5",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Api-Key ${savedKey}`);
    });
  });

  test("together saved key overrides TOGETHER_API_KEY", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-together-key";
    const envKey = "env-together-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        together: {
          service: "together",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("TOGETHER_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "together",
        model: "moonshotai/Kimi-K2.5",
        subAgentModel: "moonshotai/Kimi-K2.5",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Bearer ${savedKey}`);
    });
  });

  test("opencode-go saved key overrides OPENCODE_API_KEY", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-opencode-key";
    const envKey = "env-opencode-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        "opencode-go": {
          service: "opencode-go",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("OPENCODE_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "opencode-go",
        model: "glm-5",
        subAgentModel: "glm-5",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Bearer ${savedKey}`);
    });
  });

  test("opencode-zen saved key overrides OPENCODE_ZEN_API_KEY", async () => {
    const { home } = await makeTmpDirs();
    const savedKey = "saved-opencode-zen-key";
    const envKey = "env-opencode-zen-key";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        "opencode-zen": {
          service: "opencode-zen",
          mode: "api_key",
          apiKey: savedKey,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("OPENCODE_ZEN_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "opencode-zen",
        model: "glm-5",
        subAgentModel: "glm-5",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Bearer ${savedKey}`);
    });
  });

  test("codex-cli provider does not reuse saved openai key", async () => {
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
    const headers = await model.config.headers();
    expect(headers.authorization).toBeUndefined();
    expect(model.provider).toBe("codex-cli.responses");
  });

  test("codex-cli model headers import legacy ~/.codex auth into Cowork auth when Cowork auth is missing", async () => {
    const { home } = await makeTmpDirs();

    await writeJson(path.join(home, ".codex", "auth.json"), {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "legacy-access-token",
        refresh_token: "legacy-refresh-token",
      },
    });

    const cfg = makeConfig({
      provider: "codex-cli",
      model: "gpt-5-codex",
      userAgentDir: path.join(home, ".agent"),
    });

    const model = getModel(cfg) as any;
    const headers = await model.config.headers();
    expect(headers.authorization).toBe("Bearer legacy-access-token");

    const persisted = JSON.parse(
      await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8")
    ) as any;
    expect(persisted?.tokens?.access_token).toBe("legacy-access-token");
    expect(persisted?.tokens?.refresh_token).toBe("legacy-refresh-token");
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

  test("opencode-go falls back to OPENCODE_API_KEY when saved entry has no api key", async () => {
    const { home } = await makeTmpDirs();
    const envKey = "env-opencode-fallback";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        "opencode-go": {
          service: "opencode-go",
          mode: "oauth_pending",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("OPENCODE_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "opencode-go",
        model: "glm-5",
        subAgentModel: "glm-5",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Bearer ${envKey}`);
    });
  });

  test("baseten falls back to BASETEN_API_KEY when saved entry has no api key", async () => {
    const { home } = await makeTmpDirs();
    const envKey = "env-baseten-fallback";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        baseten: {
          service: "baseten",
          mode: "oauth_pending",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("BASETEN_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "baseten",
        model: "moonshotai/Kimi-K2.5",
        subAgentModel: "moonshotai/Kimi-K2.5",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Api-Key ${envKey}`);
    });
  });

  test("together falls back to TOGETHER_API_KEY when saved entry has no api key", async () => {
    const { home } = await makeTmpDirs();
    const envKey = "env-together-fallback";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        together: {
          service: "together",
          mode: "oauth_pending",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("TOGETHER_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "together",
        model: "moonshotai/Kimi-K2.5",
        subAgentModel: "moonshotai/Kimi-K2.5",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Bearer ${envKey}`);
    });
  });

  test("opencode-zen falls back to OPENCODE_ZEN_API_KEY when saved entry has no api key", async () => {
    const { home } = await makeTmpDirs();
    const envKey = "env-opencode-zen-fallback";

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        "opencode-zen": {
          service: "opencode-zen",
          mode: "oauth_pending",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("OPENCODE_ZEN_API_KEY", envKey, async () => {
      const cfg = makeConfig({
        provider: "opencode-zen",
        model: "glm-5",
        subAgentModel: "glm-5",
        userAgentDir: path.join(home, ".agent"),
      });

      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe(`Bearer ${envKey}`);
    });
  });
});
