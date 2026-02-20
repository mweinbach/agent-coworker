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
      const model = getModelForProvider(config, "claude-4-6-sonnet", "anthropic-key") as any;
      const headers = await model.config.headers();
      expect(model.modelId).toBe("claude-sonnet-4-6");
      expect(headers["x-api-key"]).toBe("anthropic-key");
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

    test("returns key candidates for codex-cli", () => {
      expect(getProviderKeyCandidates("codex-cli")).toBe(PROVIDERS["codex-cli"].keyCandidates);
    });
  });
});
