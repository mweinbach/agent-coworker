import { describe, expect, test } from "bun:test";

import {
  createAnthropicModelAdapter,
  createBasetenModelAdapter,
  createCodexAppServerModelAdapter,
  createGoogleModelAdapter,
  createMinimaxModelAdapter,
  createNvidiaModelAdapter,
  createOpenAiModelAdapter,
  createTogetherModelAdapter,
} from "../../src/providers/modelAdapter";
import { makeConfig, withEnv } from "./helpers";

describe("provider model adapters", () => {
  test("OpenAI adapter prefers saved key over env", async () => {
    await withEnv("OPENAI_API_KEY", "env-key", async () => {
      const adapter = createOpenAiModelAdapter("gpt-5.2", "saved-key");
      const headers = await adapter.config.headers();
      expect(headers.authorization).toBe("Bearer saved-key");
    });
  });

  test("OpenAI adapter falls back to env key", async () => {
    await withEnv("OPENAI_API_KEY", "env-key", async () => {
      const adapter = createOpenAiModelAdapter("gpt-5.2");
      const headers = await adapter.config.headers();
      expect(headers.authorization).toBe("Bearer env-key");
    });
  });

  test("Google adapter wires x-goog-api-key header", async () => {
    await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "gkey", async () => {
      const adapter = createGoogleModelAdapter("gemini-3.1");
      const headers = await adapter.config.headers();
      expect(headers["x-goog-api-key"]).toBe("gkey");
    });
  });

  test("Google adapter falls back to GOOGLE_API_KEY", async () => {
    await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", undefined, async () => {
      await withEnv("GOOGLE_API_KEY", "alias-key", async () => {
        const adapter = createGoogleModelAdapter("gemini-3.1");
        const headers = await adapter.config.headers();
        expect(headers["x-goog-api-key"]).toBe("alias-key");
      });
    });
  });

  test("Anthropic adapter wires x-api-key header", async () => {
    await withEnv("ANTHROPIC_API_KEY", "akey", async () => {
      const adapter = createAnthropicModelAdapter("claude-opus-4-6");
      const headers = await adapter.config.headers();
      expect(headers["x-api-key"]).toBe("akey");
    });
  });

  test("Baseten adapter wires Api-Key authorization header", async () => {
    await withEnv("BASETEN_API_KEY", "bkey", async () => {
      const adapter = createBasetenModelAdapter("moonshotai/Kimi-K2.5");
      const headers = await adapter.config.headers();
      expect(headers.authorization).toBe("Api-Key bkey");
    });
  });

  test("Together adapter wires Bearer authorization header", async () => {
    await withEnv("TOGETHER_API_KEY", "tkey", async () => {
      const adapter = createTogetherModelAdapter("moonshotai/Kimi-K2.5");
      const headers = await adapter.config.headers();
      expect(headers.authorization).toBe("Bearer tkey");
    });
  });

  test("NVIDIA adapter wires Bearer authorization header", async () => {
    await withEnv("NVIDIA_API_KEY", "nvkey", async () => {
      const adapter = createNvidiaModelAdapter("nvidia/nemotron-3-super-120b-a12b");
      const headers = await adapter.config.headers();
      expect(headers.authorization).toBe("Bearer nvkey");
    });
  });

  test("MiniMax adapter wires Bearer authorization header and baseUrl", async () => {
    await withEnv("MINIMAX_API_KEY", "mmkey", async () => {
      const adapter = createMinimaxModelAdapter("MiniMax-M3");
      const headers = await adapter.config.headers();
      expect(headers.authorization).toBe("Bearer mmkey");
      expect(adapter.provider).toBe("minimax.completions");
      expect(adapter.config.baseUrl).toBe("https://api.minimax.io/v1");
    });
  });

  test("adapters omit auth headers when no key source is available", async () => {
    await withEnv("OPENAI_API_KEY", undefined, async () => {
      await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", undefined, async () => {
        await withEnv("GOOGLE_API_KEY", undefined, async () => {
          await withEnv("ANTHROPIC_API_KEY", undefined, async () => {
            await withEnv("BASETEN_API_KEY", undefined, async () => {
              await withEnv("TOGETHER_API_KEY", undefined, async () => {
                await withEnv("NVIDIA_API_KEY", undefined, async () => {
                  await withEnv("MINIMAX_API_KEY", undefined, async () => {
                    const openAiHeaders =
                      await createOpenAiModelAdapter("gpt-5.2").config.headers();
                    const googleHeaders =
                      await createGoogleModelAdapter("gemini-3.1").config.headers();
                    const anthropicHeaders =
                      await createAnthropicModelAdapter("claude-opus-4-6").config.headers();
                    const basetenHeaders =
                      await createBasetenModelAdapter("moonshotai/Kimi-K2.5").config.headers();
                    const togetherHeaders =
                      await createTogetherModelAdapter("moonshotai/Kimi-K2.5").config.headers();
                    const nvidiaHeaders = await createNvidiaModelAdapter(
                      "nvidia/nemotron-3-super-120b-a12b",
                    ).config.headers();
                    const minimaxHeaders =
                      await createMinimaxModelAdapter("MiniMax-M3").config.headers();

                    expect(openAiHeaders).toEqual({});
                    expect(googleHeaders).toEqual({});
                    expect(anthropicHeaders).toEqual({});
                    expect(basetenHeaders).toEqual({});
                    expect(togetherHeaders).toEqual({});
                    expect(nvidiaHeaders).toEqual({});
                    expect(minimaxHeaders).toEqual({});
                  });
                });
              });
            });
          });
        });
      });
    });
  });

  test("Codex app-server adapter ignores Cowork-managed auth headers", async () => {
    const config = makeConfig({ provider: "codex-cli" });
    const adapter = createCodexAppServerModelAdapter(config, "gpt-5.2", "sk-abc");
    const headers = await adapter.config.headers();
    expect(adapter.provider).toBe("codex-app-server");
    expect(headers).toEqual({});
  });
});
