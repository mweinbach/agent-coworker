import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createAnthropicModelAdapter,
  createAwsBedrockProxyModelAdapter,
  createBasetenModelAdapter,
  createCodexCliModelAdapter,
  createGoogleModelAdapter,
  createNvidiaModelAdapter,
  createOpenAiModelAdapter,
  createTogetherModelAdapter,
} from "../../src/providers/modelAdapter";
import { makeConfig, makeTmpDirs, withEnv, writeJson } from "./helpers";

async function writeCodexAuth(home: string, overrides: Partial<{
  accessToken: string;
  accountId: string;
  expiresAtMs: number;
}> = {}) {
  const authFile = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
  await writeJson(authFile, {
    version: 1,
    auth_mode: "chatgpt",
    issuer: "https://auth.openai.com",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      tokens: {
        access_token: overrides.accessToken ?? "codex-token",
        refresh_token: "refresh-token",
        expires_at: overrides.expiresAtMs ?? Date.now() + 3_600_000,
      },
    account: {
      account_id: overrides.accountId ?? "acct-123",
    },
  });
}

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

  test("AWS Bedrock Proxy adapter resolves baseUrl from provider options before global config", async () => {
    const config = makeConfig({
      provider: "aws-bedrock-proxy",
      model: "router",
      preferredChildModel: "router",
      awsBedrockProxyBaseUrl: "https://proxy.global.example.com/v1",
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.workspace.example.com/v1/",
        },
      },
    });

    const adapter = createAwsBedrockProxyModelAdapter(config, "router", "proxy-token");
    const headers = await adapter.config.headers();

    expect(adapter.modelId).toBe("router");
    expect(adapter.provider).toBe("aws-bedrock-proxy.completions");
    expect(adapter.config.baseUrl).toBe("https://proxy.workspace.example.com/v1");
    expect(headers.authorization).toBe("Bearer proxy-token");
    expect(headers.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
  });

  test("AWS Bedrock Proxy adapter falls back to global config baseUrl", async () => {
    const config = makeConfig({
      provider: "aws-bedrock-proxy",
      model: "router",
      preferredChildModel: "router",
      awsBedrockProxyBaseUrl: "https://proxy.global.example.com/v1/",
    });

    const adapter = createAwsBedrockProxyModelAdapter(config, "router");

    expect(adapter.config.baseUrl).toBe("https://proxy.global.example.com/v1");
  });

  test("adapters omit auth headers when no key source is available", async () => {
    await withEnv("OPENAI_API_KEY", undefined, async () => {
      await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", undefined, async () => {
        await withEnv("GOOGLE_API_KEY", undefined, async () => {
          await withEnv("ANTHROPIC_API_KEY", undefined, async () => {
            await withEnv("BASETEN_API_KEY", undefined, async () => {
              await withEnv("TOGETHER_API_KEY", undefined, async () => {
                await withEnv("NVIDIA_API_KEY", undefined, async () => {
                  const openAiHeaders = await createOpenAiModelAdapter("gpt-5.2").config.headers();
                  const googleHeaders = await createGoogleModelAdapter("gemini-3.1").config.headers();
                  const anthropicHeaders = await createAnthropicModelAdapter("claude-opus-4-6").config.headers();
                  const basetenHeaders = await createBasetenModelAdapter("moonshotai/Kimi-K2.5").config.headers();
                  const togetherHeaders = await createTogetherModelAdapter("moonshotai/Kimi-K2.5").config.headers();
                  const nvidiaHeaders = await createNvidiaModelAdapter("nvidia/nemotron-3-super-120b-a12b").config.headers();

                  expect(openAiHeaders).toEqual({});
                  expect(googleHeaders).toEqual({});
                  expect(anthropicHeaders).toEqual({});
                  expect(basetenHeaders).toEqual({});
                  expect(togetherHeaders).toEqual({});
                  expect(nvidiaHeaders).toEqual({});
                });
              });
            });
          });
        });
      });
    });
  });

  test("Codex adapter honors saved key before disk material", async () => {
    const config = makeConfig({ provider: "codex-cli" });
    const adapter = createCodexCliModelAdapter(config, "gpt-5.2", "sk-abc");
    const headers = await adapter.config.headers();
    expect(headers.authorization).toBe("Bearer sk-abc");
  });

  test("Codex adapter falls back to Cowork auth and propagates ChatGPT-Account-ID", async () => {
    const { home, tmp } = await makeTmpDirs();
    try {
      await withEnv("HOME", home, async () => {
        await writeCodexAuth(home);
        const workspaceDir = path.join(tmp, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        const config = makeConfig({
          provider: "codex-cli",
          userAgentDir: path.join(workspaceDir, ".agent"),
        });

        const adapter = createCodexCliModelAdapter(config, "gpt-5.2");
        const headers = await adapter.config.headers();

        expect(headers.authorization).toBe("Bearer codex-token");
        expect(headers["ChatGPT-Account-ID"]).toBe("acct-123");
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
