import { describe, expect, test } from "bun:test";
import {
  defaultModelForProvider,
  getModelForProvider,
  getProviderKeyCandidates,
  PROVIDERS,
} from "../../src/providers";
import { makeConfig } from "./helpers";

describe("src/providers/index.ts", () => {
  describe("getModelForProvider", () => {
    test("creates a runnable OpenAI model with saved key", async () => {
      const config = makeConfig({ provider: "openai" });
      const model = getModelForProvider(config, "gpt-5.2", "openai-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("gpt-5.2");
      expect(headers.authorization).toBe("Bearer openai-key");
    });

    test("creates a runnable Google model with saved key", async () => {
      const config = makeConfig({ provider: "google" });
      const model = getModelForProvider(config, "gemini-3-flash-preview", "google-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("gemini-3-flash-preview");
      expect(headers["x-goog-api-key"]).toBe("google-key");
    });

    test("creates Anthropic model and normalizes known alias model IDs", async () => {
      const config = makeConfig({ provider: "anthropic" });
      const model = getModelForProvider(config, "claude-sonnet-4-6", "anthropic-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("claude-sonnet-4-6");
      expect(headers["x-api-key"]).toBe("anthropic-key");
    });

    test("creates Baseten model with saved key", async () => {
      const config = makeConfig({
        provider: "baseten",
        model: "moonshotai/Kimi-K2.5",
        preferredChildModel: "moonshotai/Kimi-K2.5",
      });
      const model = getModelForProvider(config, "moonshotai/Kimi-K2.5", "baseten-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("moonshotai/Kimi-K2.5");
      expect(model.provider).toBe("baseten.completions");
      expect(headers.authorization).toBe("Api-Key baseten-key");
    });

    test("creates Together AI model with saved key", async () => {
      const config = makeConfig({
        provider: "together",
        model: "moonshotai/Kimi-K2.5",
        preferredChildModel: "moonshotai/Kimi-K2.5",
      });
      const model = getModelForProvider(config, "moonshotai/Kimi-K2.5", "together-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("moonshotai/Kimi-K2.5");
      expect(model.provider).toBe("together.completions");
      expect(headers.authorization).toBe("Bearer together-key");
    });

    test("creates NVIDIA model with saved key", async () => {
      const config = makeConfig({
        provider: "nvidia",
        model: "nvidia/nemotron-3-super-120b-a12b",
        preferredChildModel: "nvidia/nemotron-3-super-120b-a12b",
      });
      const model = getModelForProvider(config, "nvidia/nemotron-3-super-120b-a12b", "nvidia-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("nvidia/nemotron-3-super-120b-a12b");
      expect(model.provider).toBe("nvidia.completions");
      expect(headers.authorization).toBe("Bearer nvidia-key");
    });


    test("creates OpenAI-API Proxy model with saved key", async () => {
      const config = makeConfig({ provider: "openai-proxy", model: "anthropic.claude-sonnet-4-5", preferredChildModel: "anthropic.claude-sonnet-4-5" });
      const model = getModelForProvider(config, "anthropic.claude-sonnet-4-5", "proxy-key") as any;
      expect(model.provider).toBe("openai-proxy.completions");
      const headers = await model.config.headers();
      expect(headers.authorization).toBe("Bearer proxy-key");
      expect(headers.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
    });

    test("creates OpenCode Go model with saved key", async () => {
      const config = makeConfig({ provider: "opencode-go", model: "glm-5", preferredChildModel: "glm-5" });
      const model = getModelForProvider(config, "glm-5", "opencode-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("glm-5");
      expect(model.provider).toBe("opencode-go.completions");
      expect(headers.authorization).toBe("Bearer opencode-key");
    });

    test("creates OpenCode Zen model with saved key", async () => {
      const config = makeConfig({ provider: "opencode-zen", model: "glm-5", preferredChildModel: "glm-5" });
      const model = getModelForProvider(config, "glm-5", "opencode-zen-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("glm-5");
      expect(model.provider).toBe("opencode-zen.completions");
      expect(headers.authorization).toBe("Bearer opencode-zen-key");
    });

    test("creates Zen-only OpenCode model with saved key", async () => {
      const config = makeConfig({ provider: "opencode-zen", model: "minimax-m2.5", preferredChildModel: "glm-5" });
      const model = getModelForProvider(config, "minimax-m2.5", "opencode-zen-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("minimax-m2.5");
      expect(model.provider).toBe("opencode-zen.completions");
      expect(headers.authorization).toBe("Bearer opencode-zen-key");
    });

    test("rejects Zen-only OpenCode models on opencode-go", () => {
      const config = makeConfig({ provider: "opencode-go", model: "glm-5", preferredChildModel: "glm-5" });
      expect(() => getModelForProvider(config, "minimax-m2.5")).toThrow(
        'Unsupported model "minimax-m2.5" for provider opencode-go.',
      );
    });

    test("creates codex-cli model with saved key without codex auth files", async () => {
      const config = makeConfig({ provider: "codex-cli" });
      const model = getModelForProvider(config, "gpt-5.2-codex", "openai-fallback-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("gpt-5.2-codex");
      expect(model.provider).toBe("codex-cli.responses");
      expect(headers.authorization).toBe("Bearer openai-fallback-key");
    });
  });

  describe("defaultModelForProvider", () => {
    test("returns catalog defaults for all providers", () => {
      expect(defaultModelForProvider("google")).toBe(PROVIDERS.google.defaultModel);
      expect(defaultModelForProvider("openai")).toBe(PROVIDERS.openai.defaultModel);
      expect(defaultModelForProvider("anthropic")).toBe(PROVIDERS.anthropic.defaultModel);
      expect(defaultModelForProvider("baseten")).toBe(PROVIDERS.baseten.defaultModel);
      expect(defaultModelForProvider("together")).toBe(PROVIDERS.together.defaultModel);
      expect(defaultModelForProvider("nvidia")).toBe(PROVIDERS.nvidia.defaultModel);
      expect(defaultModelForProvider("opencode-go")).toBe(PROVIDERS["opencode-go"].defaultModel);
      expect(defaultModelForProvider("opencode-zen")).toBe(PROVIDERS["opencode-zen"].defaultModel);
      expect(defaultModelForProvider("openai-proxy")).toBe(PROVIDERS["openai-proxy"].defaultModel);
      expect(defaultModelForProvider("codex-cli")).toBe(PROVIDERS["codex-cli"].defaultModel);
    });
  });

  describe("getProviderKeyCandidates", () => {
    test("returns key candidates for google", () => {
      expect(getProviderKeyCandidates("google")).toBe(PROVIDERS.google.keyCandidates);
    });

    test("returns key candidates for openai", () => {
      expect(getProviderKeyCandidates("openai")).toBe(PROVIDERS.openai.keyCandidates);
    });

    test("returns key candidates for anthropic", () => {
      expect(getProviderKeyCandidates("anthropic")).toBe(PROVIDERS.anthropic.keyCandidates);
    });

    test("returns key candidates for baseten", () => {
      expect(getProviderKeyCandidates("baseten")).toBe(PROVIDERS.baseten.keyCandidates);
    });

    test("returns key candidates for together", () => {
      expect(getProviderKeyCandidates("together")).toBe(PROVIDERS.together.keyCandidates);
    });

    test("returns key candidates for nvidia", () => {
      expect(getProviderKeyCandidates("nvidia")).toBe(PROVIDERS.nvidia.keyCandidates);
    });

    test("returns key candidates for opencode-go", () => {
      expect(getProviderKeyCandidates("opencode-go")).toBe(PROVIDERS["opencode-go"].keyCandidates);
    });

    test("returns key candidates for opencode-zen", () => {
      expect(getProviderKeyCandidates("opencode-zen")).toBe(PROVIDERS["opencode-zen"].keyCandidates);
    });

    test("returns key candidates for codex-cli", () => {
      expect(getProviderKeyCandidates("codex-cli")).toBe(PROVIDERS["codex-cli"].keyCandidates);
    });
  });
});
