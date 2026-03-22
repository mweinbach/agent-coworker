import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";
import { getAiCoworkerPaths } from "../src/connect";
import { defaultSupportedModel } from "../src/models/registry";
import { CODEX_BACKEND_BASE_URL, writeCodexAuthMaterial } from "../src/providers/codex-auth";
import { resolveOpenAiResponsesModel } from "../src/runtime/openaiResponsesModel";
import { __internal as piRuntimeInternal, createPiRuntime } from "../src/runtime/piRuntime";
import { MODEL_SCRATCHPAD_DIRNAME, TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS } from "../src/shared/toolOutputOverflow";

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

function makeConfig(homeDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5.2",
    preferredChildModel: "gpt-5.2",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(homeDir, ".agent-project"),
    userAgentDir: path.join(homeDir, ".agent"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [path.join(homeDir, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function makeParams(config: AgentConfig, overrides: Partial<RuntimeRunTurnParams> = {}): RuntimeRunTurnParams {
  return {
    config,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }] as ModelMessage[],
    tools: {},
    maxSteps: 1,
    ...overrides,
  };
}

function pickCodexModelId(): string {
  return defaultSupportedModel("codex-cli").id;
}

async function withEnv<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[key];
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];

  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

async function withMockedFetch<T>(
  fetchImpl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

type PromptCachingTtl = "5m" | "1h";

function extractPromptCachingTtl(content: unknown): PromptCachingTtl | null {
  if (!Array.isArray(content)) return null;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const entry = content[index];
    if (typeof entry !== "object" || entry === null) continue;
    const part = entry as Record<string, unknown>;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (typeof part.cache_control !== "object" || part.cache_control === null) return null;
    const ttl = (part.cache_control as Record<string, unknown>).ttl;
    return ttl === "1h" ? "1h" : "5m";
  }
  return null;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const part = entry as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return "";
}

async function parseProxyFetchPayload(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ label: string; ttl: PromptCachingTtl | null } | null> {
  const body = typeof init?.body === "string"
    ? init.body
    : input instanceof Request
      ? await input.clone().text()
      : null;
  if (!body) return null;
  const payload = JSON.parse(body) as Record<string, unknown>;
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) return null;
  const first = payload.messages[0];
  if (typeof first !== "object" || first === null) return null;
  const firstMessage = first as Record<string, unknown>;
  return {
    label: extractMessageText(firstMessage.content),
    ttl: extractPromptCachingTtl(firstMessage.content),
  };
}

describe("pi runtime regressions", () => {
  test("calls onModelAbort exactly once when turn starts with an aborted signal", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-abort-"));
    const runtime = createPiRuntime();
    const controller = new AbortController();
    controller.abort();
    const onModelAbort = mock(async () => {});

    await expect(
      runtime.runTurn(
        makeParams(makeConfig(homeDir), {
          abortSignal: controller.signal,
          onModelAbort,
        })
      )
    ).rejects.toThrow("Model turn aborted.");

    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });

  test("codex runtime model resolution preserves ChatGPT-Account-ID headers", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-codex-"));
    const paths = getAiCoworkerPaths({ homedir: homeDir });
    const workspaceDir = path.join(homeDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    await writeCodexAuthMaterial(paths, {
      accessToken: "tok_live",
      refreshToken: "refresh_live",
      accountId: "acct_123",
      expiresAtMs: Date.now() + 10 * 60_000,
      issuer: "https://auth.example.invalid",
      clientId: "client-id",
    });

    const config = makeConfig(homeDir, {
      provider: "codex-cli",
      model: pickCodexModelId(),
      preferredChildModel: pickCodexModelId(),
      userAgentDir: path.join(workspaceDir, ".agent"),
    });

    const resolved = await resolveOpenAiResponsesModel(makeParams(config));

    expect(resolved.apiKey).toBe("tok_live");
    expect(resolved.headers).toEqual({ "ChatGPT-Account-ID": "acct_123" });
    expect(resolved.model.baseUrl).toBe(CODEX_BACKEND_BASE_URL);
    expect(resolved.model.headers).toMatchObject({ "ChatGPT-Account-ID": "acct_123" });
    expect(resolved.model.contextWindow).toBe(272000);
    expect(resolved.model.maxTokens).toBe(128000);
  });

  test("codex runtime model resolution imports legacy ~/.codex auth into Cowork auth", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-codex-legacy-"));
    const workspaceDir = path.join(homeDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const legacyPath = path.join(homeDir, ".codex", "auth.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "legacy-access-token",
          refresh_token: "legacy-refresh-token",
          id_token: makeJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "acct_legacy" },
          }),
        },
      }),
      "utf-8",
    );

    const config = makeConfig(homeDir, {
      provider: "codex-cli",
      model: pickCodexModelId(),
      preferredChildModel: pickCodexModelId(),
      userAgentDir: path.join(workspaceDir, ".agent"),
    });

    const resolved = await resolveOpenAiResponsesModel(makeParams(config));

    expect(resolved.apiKey).toBe("legacy-access-token");
    expect(resolved.accountId).toBe("acct_legacy");

    const importedRaw = await fs.readFile(
      path.join(homeDir, ".cowork", "auth", "codex-cli", "auth.json"),
      "utf-8",
    );
    const imported = JSON.parse(importedRaw) as Record<string, any>;
    expect(imported.tokens?.access_token).toBe("legacy-access-token");
    expect(imported.tokens?.refresh_token).toBe("legacy-refresh-token");
  });

  test("codex runtime model resolution keeps supported OpenAI token limits when using a saved API key", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-codex-saved-key-"));
    const paths = getAiCoworkerPaths({ homedir: homeDir });
    const workspaceDir = path.join(homeDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(
      paths.connectionsFile,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {
          "codex-cli": {
            service: "codex-cli",
            mode: "api_key",
            apiKey: "sk-codex",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      "utf-8",
    );

    const config = makeConfig(homeDir, {
      provider: "codex-cli",
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
      userAgentDir: path.join(workspaceDir, ".agent"),
    });

    const resolved = await resolveOpenAiResponsesModel(makeParams(config));

    expect(resolved.apiKey).toBe("sk-codex");
    expect(resolved.model.api).toBe("openai-responses");
    expect(resolved.model.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.model.contextWindow).toBe(400000);
    expect(resolved.model.maxTokens).toBe(128000);
  });

  test("openai responses model resolution keeps supported token limits for gpt-5.4", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-openai-gpt54-"));
    const config = makeConfig(homeDir, {
      provider: "openai",
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
    });

    const resolved = await resolveOpenAiResponsesModel(makeParams(config));

    expect(resolved.model.api).toBe("openai-responses");
    expect(resolved.model.contextWindow).toBe(400000);
    expect(resolved.model.maxTokens).toBe(128000);
  });

  test("openai responses model resolution keeps supported token limits for gpt-5.4-mini", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-openai-gpt54mini-"));
    const config = makeConfig(homeDir, {
      provider: "openai",
      model: "gpt-5.4-mini",
      preferredChildModel: "gpt-5.4-mini",
    });

    const resolved = await resolveOpenAiResponsesModel(makeParams(config));

    expect(resolved.model.api).toBe("openai-responses");
    expect(resolved.model.contextWindow).toBe(400000);
    expect(resolved.model.maxTokens).toBe(128000);
  });

  test("LM Studio PI model resolution builds a dynamic openai-completions model from live metadata", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-lmstudio-"));
    const paths = getAiCoworkerPaths({ homedir: homeDir });
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(
      paths.connectionsFile,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {
          lmstudio: {
            service: "lmstudio",
            mode: "api_key",
            apiKey: "lmstudio-token",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      "utf-8",
    );

    const config = makeConfig(homeDir, {
      provider: "lmstudio",
      model: "local/qwen-2.5",
      preferredChildModel: "local/qwen-2.5",
      knowledgeCutoff: "Unknown",
      providerOptions: {
        lmstudio: {
          baseUrl: "http://127.0.0.1:1234",
          contextLength: 8192,
        },
      },
    });

    const resolved = await withMockedFetch(
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/models")) {
          return new Response(JSON.stringify({
            models: [
              {
                type: "llm",
                publisher: "local",
                key: "local/qwen-2.5",
                display_name: "Qwen 2.5 Local",
                loaded_instances: [],
                max_context_length: 32768,
                capabilities: { vision: true, trained_for_tool_use: false },
                size_bytes: 1,
                architecture: "llama",
                format: "gguf",
              },
            ],
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({
          type: "llm",
          instance_id: "inst-1",
          load_time_seconds: 0.25,
          status: "loaded",
          load_config: {
            context_length: 8192,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      async () => await piRuntimeInternal.resolvePiModel(makeParams(config, {
        providerOptions: config.providerOptions,
      })),
    );

    expect(resolved.model.id).toBe("local/qwen-2.5");
    expect(resolved.model.name).toBe("Qwen 2.5 Local");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.provider).toBe("lmstudio");
    expect(resolved.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(resolved.model.contextWindow).toBe(8192);
    expect(resolved.model.maxTokens).toBe(2048);
    expect(resolved.model.input).toEqual(["text", "image"]);
    expect(resolved.headers).toEqual({ authorization: "Bearer lmstudio-token" });
    expect(resolved.apiKey).toBe("lmstudio-token");
  });

  test("LM Studio PI model resolution does not require an API key for local inference", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-lmstudio-local-"));
    const config = makeConfig(homeDir, {
      provider: "lmstudio",
      model: "local/qwen-2.5",
      preferredChildModel: "local/qwen-2.5",
      knowledgeCutoff: "Unknown",
      providerOptions: {
        lmstudio: {
          baseUrl: "http://127.0.0.1:1234",
          autoLoad: false,
        },
      },
    });

    const resolved = await withEnv("OPENAI_API_KEY", undefined, async () =>
      await withMockedFetch(
        (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/api/v1/models")) {
            return new Response(JSON.stringify({
              models: [
                {
                  type: "llm",
                  publisher: "local",
                  key: "local/qwen-2.5",
                  display_name: "Qwen 2.5 Local",
                  loaded_instances: [],
                  max_context_length: 32768,
                  capabilities: { vision: false, trained_for_tool_use: false },
                  size_bytes: 1,
                  architecture: "llama",
                  format: "gguf",
                },
              ],
            }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`unexpected fetch url: ${url}`);
        }) as typeof fetch,
        async () => await piRuntimeInternal.resolvePiModel(makeParams(config, {
          providerOptions: config.providerOptions,
        })),
      )
    );

    expect(resolved.model.id).toBe("local/qwen-2.5");
    expect(resolved.model.provider).toBe("lmstudio");
    expect(resolved.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(resolved.apiKey).toBe("lmstudio-local");
    expect(resolved.headers).toBeUndefined();
  });

  test("LM Studio PI runtime seeds follow-up turns from the bounded runtime message window", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-lmstudio-history-"));
    const streamCalls: Array<Record<string, unknown>> = [];
    const runtime = createPiRuntime({
      piStreamImpl: ((model: unknown, input: Record<string, unknown>) => {
        streamCalls.push({
          model,
          systemPrompt: input.systemPrompt,
          messages: input.messages,
        });
        return {
          async *[Symbol.asyncIterator]() {
            return;
          },
          async result() {
            return {
              role: "assistant",
              content: [{ type: "text", text: "follow-up answer" }],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: "stop",
            };
          },
        };
      }) as any,
    });

    const config = makeConfig(homeDir, {
      provider: "lmstudio",
      model: "local/qwen-2.5",
      preferredChildModel: "local/qwen-2.5",
      knowledgeCutoff: "Unknown",
      providerOptions: {
        lmstudio: {
          baseUrl: "http://127.0.0.1:1234",
          autoLoad: false,
        },
      },
    });

    await withMockedFetch(
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/models")) {
          return new Response(JSON.stringify({
            models: [
              {
                type: "llm",
                publisher: "local",
                key: "local/qwen-2.5",
                display_name: "Qwen 2.5 Local",
                loaded_instances: [],
                max_context_length: 32768,
                capabilities: { vision: false, trained_for_tool_use: true },
                size_bytes: 1,
                architecture: "llama",
                format: "gguf",
              },
            ],
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch url: ${url}`);
      }) as typeof fetch,
      async () => {
        const result = await runtime.runTurn(
          makeParams(config, {
            messages: [
              { role: "user", content: "request inside the window" },
              {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "/tmp/a.ts" } },
                  { type: "text", text: "Earlier answer" },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "read",
                    output: { type: "json", value: { ok: true } },
                  },
                ],
              },
              { role: "user", content: "follow-up question" },
            ] as ModelMessage[],
            allMessages: [
              { role: "user", content: "stale older request" },
              { role: "assistant", content: [{ type: "text", text: "stale older answer" }] },
              { role: "user", content: "request inside the window" },
              {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "/tmp/a.ts" } },
                  { type: "text", text: "Earlier answer" },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "read",
                    output: { type: "json", value: { ok: true } },
                  },
                ],
              },
              { role: "user", content: "follow-up question" },
            ] as ModelMessage[],
          }),
        );

        expect(result.text).toBe("follow-up answer");
      },
    );

    expect(streamCalls).toHaveLength(1);
    const piMessages = (streamCalls[0]?.messages as Array<Record<string, unknown>> | undefined) ?? [];
    expect(piMessages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(piMessages[0]?.content).toBe("request inside the window");
    expect((piMessages[1]?.content as Array<Record<string, unknown>> | undefined)).toEqual([
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a.ts" } },
      { type: "text", text: "Earlier answer" },
    ]);
    expect(piMessages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "{\"ok\":true}" }],
    });
    expect(piMessages[3]?.content).toBe("follow-up question");
  });

  test("codex openai-key runtime model resolution keeps supported token limits for gpt-5.4-mini", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-codex-gpt54mini-"));
    const homeDir = path.join(workspaceDir, "home");
    await fs.mkdir(homeDir, { recursive: true });
    const paths = getAiCoworkerPaths({ homedir: homeDir });
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(
      paths.connectionsFile,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {
          "codex-cli": {
            service: "codex-cli",
            mode: "api_key",
            apiKey: "sk-codex",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      "utf-8",
    );

    const config = makeConfig(homeDir, {
      provider: "codex-cli",
      model: "gpt-5.4-mini",
      preferredChildModel: "gpt-5.4-mini",
      userAgentDir: path.join(workspaceDir, ".agent"),
    });

    const resolved = await resolveOpenAiResponsesModel(makeParams(config));

    expect(resolved.apiKey).toBe("sk-codex");
    expect(resolved.model.api).toBe("openai-responses");
    expect(resolved.model.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.model.contextWindow).toBe(400000);
    expect(resolved.model.maxTokens).toBe(128000);
  });

  test("opencode-go runtime model resolution returns explicit GLM-5 PI metadata", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-opencode-glm-"));
    const config = makeConfig(homeDir, {
      provider: "opencode-go",
      model: "glm-5",
      preferredChildModel: "glm-5",
    });

    const resolved = await withEnv("OPENCODE_API_KEY", undefined, async () => (
      await piRuntimeInternal.resolvePiModel(makeParams(config))
    ));

    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.model).toMatchObject({
      id: "glm-5",
      api: "openai-completions",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      contextWindow: 204800,
      maxTokens: 131072,
    });
    expect(resolved.model.cost).toBeUndefined();
  });

  test("opencode-go runtime model resolution returns explicit Kimi K2.5 PI metadata", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-opencode-kimi-"));
    const config = makeConfig(homeDir, {
      provider: "opencode-go",
      model: "kimi-k2.5",
      preferredChildModel: "kimi-k2.5",
    });

    const resolved = await withEnv("OPENCODE_API_KEY", undefined, async () => (
      await piRuntimeInternal.resolvePiModel(makeParams(config))
    ));

    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.model).toMatchObject({
      id: "kimi-k2.5",
      api: "openai-completions",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 65536,
    });
    expect(resolved.model.input).toEqual(["text", "image"]);
    expect(resolved.model.cost).toBeUndefined();
  });

  test("baseten runtime model resolution returns explicit Kimi K2.5 metadata and env-key fallback", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-baseten-kimi-"));
    const config = makeConfig(homeDir, {
      provider: "baseten",
      model: "moonshotai/Kimi-K2.5",
      preferredChildModel: "moonshotai/Kimi-K2.5",
    });

    const resolved = await withEnv("BASETEN_API_KEY", "env-baseten-key", async () => (
      await piRuntimeInternal.resolvePiModel(makeParams(config))
    ));

    expect(resolved.apiKey).toBe("env-baseten-key");
    expect(resolved.model).toMatchObject({
      id: "moonshotai/Kimi-K2.5",
      api: "openai-completions",
      provider: "baseten",
      baseUrl: "https://inference.baseten.co/v1",
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 131_072,
      cost: {
        input: 0.6,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
    expect(resolved.model.input).toEqual(["text", "image"]);
  });

  test("together runtime model resolution returns explicit Kimi K2.5 metadata and env-key fallback", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-together-kimi-"));
    const config = makeConfig(homeDir, {
      provider: "together",
      model: "moonshotai/Kimi-K2.5",
      preferredChildModel: "moonshotai/Kimi-K2.5",
    });

    const resolved = await withEnv("TOGETHER_API_KEY", "env-together-key", async () => (
      await piRuntimeInternal.resolvePiModel(makeParams(config))
    ));

    expect(resolved.apiKey).toBe("env-together-key");
    expect(resolved.model).toMatchObject({
      id: "moonshotai/Kimi-K2.5",
      api: "openai-completions",
      provider: "together",
      baseUrl: "https://api.together.xyz/v1",
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 65_536,
      cost: {
        input: 0.5,
        output: 2.8,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
    expect(resolved.model.input).toEqual(["text", "image"]);
  });

  test("nvidia runtime model resolution returns explicit Nemotron metadata and env-key fallback", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-nvidia-nemotron-"));
    const config = makeConfig(homeDir, {
      provider: "nvidia",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredChildModel: "nvidia/nemotron-3-super-120b-a12b",
    });

    const resolved = await withEnv("NVIDIA_API_KEY", "env-nvidia-key", async () => (
      await piRuntimeInternal.resolvePiModel(makeParams(config))
    ));

    expect(resolved.apiKey).toBe("env-nvidia-key");
    expect(resolved.model).toMatchObject({
      id: "nvidia/nemotron-3-super-120b-a12b",
      api: "openai-completions",
      provider: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 32_768,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        thinkingFormat: "qwen",
      },
    });
    expect(resolved.model.input).toEqual(["text"]);
    expect(resolved.model.cost).toBeUndefined();
  });

  test("nvidia request normalization forces thinking on and strips explicit token controls", () => {
    expect(piRuntimeInternal.normalizeNvidiaChatCompletionsBody({
      model: "nvidia/nemotron-3-super-120b-a12b",
      max_tokens: 16_384,
      max_completion_tokens: 8_192,
      reasoning_budget: 16_384,
      reasoning_effort: "high",
      enable_thinking: false,
      store: false,
      chat_template_kwargs: { preserve: true },
      stream: true,
    })).toEqual({
      model: "nvidia/nemotron-3-super-120b-a12b",
      chat_template_kwargs: {
        preserve: true,
        enable_thinking: true,
      },
      stream: true,
    });
  });

  test.serial("nvidia PI runtime tolerates missing local pricing metadata without surfacing model.cost errors", async () => {
    await withEnv("NVIDIA_API_KEY", "test-dummy-key", async () => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-nvidia-live-stream-"));
      const runtime = createPiRuntime();
      const config = makeConfig(homeDir, {
        provider: "nvidia",
        model: "nvidia/nemotron-3-super-120b-a12b",
        preferredChildModel: "nvidia/nemotron-3-super-120b-a12b",
      });

      const encoder = new TextEncoder();
      const requestBodies: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(typeof init?.body === "string" ? init.body : "");
        const chunks = [
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"nvidia/nemotron-3-super-120b-a12b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"nvidia/nemotron-3-super-120b-a12b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
          'data: [DONE]\n\n',
        ];
        let index = 0;
        const body = new ReadableStream({
          pull(controller) {
            if (index >= chunks.length) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(chunks[index++]));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;

      try {
        const result = await runtime.runTurn(makeParams(config));

        expect(result.text).toBe("Hello");
        expect(result.reasoningText).toBeUndefined();
        expect(result.usage).toEqual({
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
        });
        expect(requestBodies).toHaveLength(1);
        expect(JSON.parse(requestBodies[0] ?? "{}")).toEqual({
          model: "nvidia/nemotron-3-super-120b-a12b",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "hello" },
          ],
          stream: true,
          stream_options: { include_usage: true },
          tools: [],
          chat_template_kwargs: { enable_thinking: true },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("opencode-zen runtime model resolution returns explicit GLM-5 PI metadata and env-key fallback", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-opencode-zen-"));
    const config = makeConfig(homeDir, {
      provider: "opencode-zen",
      model: "glm-5",
      preferredChildModel: "glm-5",
    });

    const resolved = await withEnv("OPENCODE_ZEN_API_KEY", "env-opencode-zen-key", async () => (
      await piRuntimeInternal.resolvePiModel(makeParams(config))
    ));

    expect(resolved.apiKey).toBe("env-opencode-zen-key");
    expect(resolved.model).toMatchObject({
      id: "glm-5",
      api: "openai-completions",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: true,
      contextWindow: 204800,
      maxTokens: 131072,
      cost: {
        input: 1,
        output: 3.2,
        cacheRead: 0.2,
        cacheWrite: 0,
      },
    });
  });

  test("opencode-zen runtime model resolution returns explicit MiniMax M2.5 PI metadata", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-opencode-zen-minimax-"));
    const config = makeConfig(homeDir, {
      provider: "opencode-zen",
      model: "minimax-m2.5",
      preferredChildModel: "glm-5",
    });

    const resolved = await piRuntimeInternal.resolvePiModel(makeParams(config));

    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.model).toMatchObject({
      id: "minimax-m2.5",
      api: "openai-completions",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: true,
      contextWindow: 204800,
      maxTokens: 65536,
      cost: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.06,
        cacheWrite: 0.375,
      },
    });
    expect(resolved.model.input).toEqual(["text"]);
  });

  test("toolMapToPiTools skips undefined tool definitions", () => {
    const mapped = piRuntimeInternal.toolMapToPiTools({
      read: {
        description: "Read files from disk.",
        inputSchema: z.object({ filePath: z.string() }),
        execute: async () => "",
      },
      webSearch: undefined,
    } as any);

    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      name: "read",
      description: "Read files from disk.",
    });
  });

  test("telemetry parsing keeps supported metadata and drops invalid values", () => {
    const parsed = piRuntimeInternal.parseTelemetrySettings({
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
      functionId: "session.turn",
      metadata: {
        sessionId: "session-123",
        attempt: 2,
        enabled: true,
        empty: null,
      },
    });

    expect(parsed).toEqual({
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
      functionId: "session.turn",
      metadata: {
        sessionId: "session-123",
        attempt: 2,
        enabled: true,
      },
    });
  });

  test("telemetry redaction strips API keys and token-like fields", () => {
    const redacted = piRuntimeInternal.redactTelemetrySecrets({
      apiKey: "key_123",
      headers: {
        authorization: "Bearer secret",
        "x-custom": "ok",
      },
      nested: {
        access_token: "tok_1",
        refresh_token: "tok_2",
        safe: true,
      },
    }) as Record<string, any>;

    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.headers.authorization).toBe("[REDACTED]");
    expect(redacted.headers["x-custom"]).toBe("ok");
    expect(redacted.nested.access_token).toBe("[REDACTED]");
    expect(redacted.nested.refresh_token).toBe("[REDACTED]");
    expect(redacted.nested.safe).toBe(true);
  });

  test("step override splitting honors messages/providerOptions and keeps stream overrides", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
    const result = piRuntimeInternal.splitStepOverrides({
      messages,
      providerOptions: { google: { thinkingConfig: { includeThoughts: false } } },
      temperature: 0.2,
      streamOptions: { maxOutputTokens: 1024 },
    });

    expect(result.messages).toEqual(messages);
    expect(result.providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: false } } });
    expect(result.streamOptions).toEqual({ maxOutputTokens: 1024 });
  });

  test("toolcall_end keeps tool IDs consistent with partial payload", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      {
        type: "toolcall_end",
        contentIndex: 0,
        partial: {
          content: [{ id: "call_partial", name: "grep", arguments: { query: "needle" } }],
        },
      },
      "openai",
      true,
      async (part) => {
        emitted.push(part as Record<string, unknown>);
      }
    );

    expect(emitted).toEqual([
      { type: "tool-input-end", id: "call_partial" },
      { type: "tool-call", toolCallId: "call_partial", toolName: "grep", input: { query: "needle" } },
    ]);
  });

  test("executeToolCall maps MCP-style isError responses to tool-error", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const result = await piRuntimeInternal.executeToolCall(
      { id: "call-1", name: "mcp__local__ping", arguments: {} },
      makeParams(makeConfig(process.cwd()), {
        tools: {
          mcp__local__ping: {
            execute: async () => ({
              isError: true,
              content: [{ type: "text", text: "permission denied" }],
            }),
          },
        },
      }),
      async (part) => {
        emitted.push(part as Record<string, unknown>);
      }
    );

    expect(emitted).toEqual([
      {
        type: "tool-error",
        toolCallId: "call-1",
        toolName: "mcp__local__ping",
        error: "permission denied",
      },
    ]);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "permission denied" }]);
  });

  test("pi runtime injects a reminder message after malformed tool-call format errors", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-tool-format-reminder-"));
    const stepMessages: ModelMessage[][] = [];
    let step = 0;
    const runtime = createPiRuntime({
      piStreamImpl: (() => ({
        async *[Symbol.asyncIterator]() {
          return;
        },
        async result() {
          step += 1;
          if (step === 1) {
            return {
              role: "assistant",
              content: [{ type: "toolCall", id: "call_bad", name: "tool", arguments: {} }],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: "toolUse",
            };
          }
          return {
            role: "assistant",
            content: [{ type: "text", text: "fixed" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          };
        },
      })) as any,
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir, {
        provider: "opencode-zen",
        model: "glm-5",
        preferredChildModel: "glm-5",
      }), {
        maxSteps: 2,
        tools: {
          read: {
            inputSchema: z.object({ filePath: z.string() }),
            execute: async () => "unused",
          },
        },
        prepareStep: async ({ messages }) => {
          stepMessages.push(messages);
          return undefined;
        },
      }),
    );

    expect(stepMessages).toHaveLength(2);
    expect(stepMessages[1]?.some((message) => {
      if (message.role !== "assistant") return false;
      return JSON.stringify(message.content).includes("Possible invalid tool call format detected");
    })).toBe(true);
    expect(JSON.stringify(result.responseMessages)).not.toContain("Possible invalid tool call format detected");
  });

  test("executeToolCall leaves short tool output inline when under the overflow threshold", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-tool-inline-"));
    const emitted: Array<Record<string, unknown>> = [];

    const result = await piRuntimeInternal.executeToolCall(
      { id: "call-short", name: "lookup", arguments: {} },
      makeParams(makeConfig(homeDir, { toolOutputOverflowChars: 100 }), {
        tools: {
          lookup: {
            execute: async () => "short output",
          },
        },
      }),
      async (part) => {
        emitted.push(part as Record<string, unknown>);
      }
    );

    expect(emitted).toEqual([
      {
        type: "tool-result",
        toolCallId: "call-short",
        toolName: "lookup",
        output: "short output",
      },
    ]);
    expect(result.content).toEqual([{ type: "text", text: "short output" }]);
    await expect(fs.readdir(path.join(homeDir, MODEL_SCRATCHPAD_DIRNAME))).rejects.toThrow();
  });

  test("executeToolCall spills oversized tool output to .ModelScratchpad and emits a companion file part", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-tool-overflow-"));
    const emitted: Array<Record<string, unknown>> = [];
    const toolOutput = {
      type: "json",
      value: {
        payload: "0123456789abcdef".repeat(32),
      },
      exitCode: 0,
      ok: true,
      count: 1,
      provider: "mock-provider",
    };

    const result = await piRuntimeInternal.executeToolCall(
      { id: "call-overflow", name: "lookup", arguments: {} },
      makeParams(makeConfig(homeDir, { toolOutputOverflowChars: 80 }), {
        tools: {
          lookup: {
            execute: async () => toolOutput,
          },
        },
      }),
      async (part) => {
        emitted.push(part as Record<string, unknown>);
      }
    );

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-overflow",
      toolName: "lookup",
      output: {
        type: "text",
        overflow: true,
        exitCode: 0,
        ok: true,
        count: 1,
        provider: "mock-provider",
      },
    });
    expect(emitted[1]).toMatchObject({
      type: "file",
      file: {
        kind: "tool-output-overflow",
        toolName: "lookup",
        toolCallId: "call-overflow",
      },
    });

    const overflowOutput = emitted[0]?.output as Record<string, unknown>;
    const fileEvent = emitted[1]?.file as Record<string, unknown>;
    const spillPath = String(overflowOutput.filePath);
    expect(spillPath).toContain(path.join(homeDir, MODEL_SCRATCHPAD_DIRNAME));
    expect(String(overflowOutput.value)).toContain("Tool output overflowed");
    expect(String(overflowOutput.value)).toContain(spillPath);
    expect(Number(overflowOutput.chars)).toBeGreaterThan(80);
    expect(fileEvent.path).toBe(spillPath);
    expect(fileEvent.chars).toBe(overflowOutput.chars);
    expect(fileEvent.preview).toBe(overflowOutput.preview);

    const saved = await fs.readFile(spillPath, "utf-8");
    expect(saved).toBe(JSON.stringify(toolOutput, null, 2));
    const spillStat = await fs.stat(spillPath);
    const scratchStat = await fs.stat(path.dirname(spillPath));
    if (process.platform === "win32") {
      expect(spillStat.mode & 0o200).toBe(0o200);
      expect(scratchStat.mode & 0o200).toBe(0o200);
    } else {
      expect(spillStat.mode & 0o777).toBe(0o600);
      expect(scratchStat.mode & 0o777).toBe(0o700);
    }

    expect(result.isError).toBe(false);
    expect(result.details).toEqual(overflowOutput);
    expect(result.content).toEqual([{ type: "text", text: String(overflowOutput.value) }]);
  });

  test("executeToolCall keeps oversized read output inline even over the overflow threshold", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-read-inline-"));
    const emitted: Array<Record<string, unknown>> = [];
    const oversized = "read-output-".repeat(400);

    const result = await piRuntimeInternal.executeToolCall(
      { id: "call-read-overflow", name: "read", arguments: { filePath: "/tmp/large.txt" } },
      makeParams(makeConfig(homeDir, { toolOutputOverflowChars: 80 }), {
        tools: {
          read: {
            execute: async () => oversized,
          },
        },
      }),
      async (part) => {
        emitted.push(part as Record<string, unknown>);
      }
    );

    expect(emitted).toEqual([
      {
        type: "tool-result",
        toolCallId: "call-read-overflow",
        toolName: "read",
        output: oversized,
      },
    ]);
    expect(result.isError).toBe(false);
    expect(result.details).toBe(oversized);
    expect(result.content).toEqual([{ type: "text", text: oversized }]);
    await expect(fs.readdir(path.join(homeDir, MODEL_SCRATCHPAD_DIRNAME))).rejects.toThrow();
  });

  test("executeToolCall preserves multimodal image tool results", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const imageResult = {
      type: "content",
      content: [
        { type: "text", text: "Image file: chart.png" },
        { type: "image", data: "abc123", mimeType: "image/png" },
      ],
    };

    const result = await piRuntimeInternal.executeToolCall(
      { id: "call-image", name: "read", arguments: { filePath: "/tmp/chart.png" } },
      makeParams(makeConfig(process.cwd()), {
        tools: {
          read: {
            execute: async () => imageResult,
          },
        },
      }),
      async (part) => {
        emitted.push(part as Record<string, unknown>);
      }
    );

    expect(emitted).toEqual([
      {
        type: "tool-result",
        toolCallId: "call-image",
        toolName: "read",
        output: imageResult,
      },
    ]);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual(imageResult.content);
  });

  test("executeToolCall spills oversized string results verbatim to .ModelScratchpad and emits a companion file part", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-overflow-tool-"));
    const emitted: Array<Record<string, unknown>> = [];
    const oversized = "overflow-result-".repeat(400);

    const result = await piRuntimeInternal.executeToolCall(
      { id: "call-overflow", name: "lookup", arguments: {} },
      makeParams(makeConfig(homeDir, { toolOutputOverflowChars: 120 }), {
        tools: {
          lookup: {
            execute: async () => oversized,
          },
        },
      }),
      async (part) => {
        emitted.push(part as Record<string, unknown>);
      }
    );

    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.type).toBe("tool-result");
    expect(emitted[1]?.type).toBe("file");

    const toolResultOutput = emitted[0]?.output as Record<string, unknown>;
    expect(toolResultOutput.type).toBe("text");
    expect(toolResultOutput.overflow).toBe(true);
    expect(toolResultOutput.chars).toBe(oversized.length);
    expect(typeof toolResultOutput.filePath).toBe("string");
    expect((toolResultOutput.filePath as string)).toContain(path.join(homeDir, ".ModelScratchpad"));
    expect((toolResultOutput.value as string).length).toBeLessThan(oversized.length);
    expect(toolResultOutput.value).toContain(toolResultOutput.filePath as string);
    expect(toolResultOutput.value).toContain(`Preview (first ${TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS.toLocaleString()} chars):`);
    expect(String(toolResultOutput.preview).startsWith(oversized.slice(0, TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS))).toBe(true);
    expect(String(toolResultOutput.preview)).toContain(
      `preview truncated ${oversized.length - TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS} chars`
    );
    expect(String(toolResultOutput.preview).length).toBeGreaterThan(120);

    const spillPath = toolResultOutput.filePath as string;
    expect(await fs.readFile(spillPath, "utf-8")).toBe(oversized);

    expect(emitted[1]?.file).toEqual({
      kind: "tool-output-overflow",
      toolName: "lookup",
      toolCallId: "call-overflow",
      path: spillPath,
      chars: oversized.length,
      preview: toolResultOutput.preview,
    });

    expect(result.isError).toBe(false);
    expect(result.details).toEqual(toolResultOutput);
    expect(result.content).toEqual([{ type: "text", text: toolResultOutput.value }]);
  });

  test.serial("nested aws-bedrock-proxy runs isolate prompt-caching rewrites by invocation", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-fetch-nested-"));
    const captured: Array<{ label: string; ttl: PromptCachingTtl | null }> = [];
    const originalFetch = globalThis.fetch;
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = await parseProxyFetchPayload(input, init);
      if (request) captured.push(request);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const outerConfig = makeConfig(homeDir, {
      provider: "aws-bedrock-proxy",
      model: "anthropic.claude-sonnet-4-5",
      preferredChildModel: "anthropic.claude-sonnet-4-5",
      awsBedrockProxyBaseUrl: "https://proxy.internal/v1",
      providerOptions: {
        "aws-bedrock-proxy": {
          promptCaching: {
            enabled: true,
            ttl: "5m",
          },
        },
      },
    });

    const outerRuntime = createPiRuntime({
      piStreamImpl: () => ({
        async *[Symbol.asyncIterator]() {
          await fetch("https://proxy.internal/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({
              model: "anthropic.claude-sonnet-4-5",
              messages: [{ role: "user", content: "outer-before" }],
            }),
          });

          const innerConfig = makeConfig(homeDir, {
            provider: "aws-bedrock-proxy",
            model: "anthropic.claude-sonnet-4-5",
            preferredChildModel: "anthropic.claude-sonnet-4-5",
            awsBedrockProxyBaseUrl: "https://proxy.internal/v1",
            providerOptions: {
              "aws-bedrock-proxy": {
                promptCaching: {
                  enabled: true,
                  ttl: "1h",
                },
              },
            },
          });

          const innerRuntime = createPiRuntime({
            piStreamImpl: () => ({
              async *[Symbol.asyncIterator]() {
                await fetch("https://proxy.internal/v1/chat/completions", {
                  method: "POST",
                  body: JSON.stringify({
                    model: "anthropic.claude-sonnet-4-5",
                    messages: [{ role: "user", content: "inner" }],
                  }),
                });
              },
              async result() {
                return {
                  role: "assistant",
                  content: [{ type: "text", text: "inner ok" }],
                  api: "openai-completions",
                  provider: "aws-bedrock-proxy",
                  model: "anthropic.claude-sonnet-4-5",
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
                  stopReason: "stop",
                  timestamp: Date.now(),
                };
              },
            }) as any,
          });

          await withEnv("AWS_BEDROCK_PROXY_API_KEY", "test-key", async () => {
            await innerRuntime.runTurn(makeParams(innerConfig, {
              providerOptions: innerConfig.providerOptions as Record<string, unknown>,
            }));
          });

          await fetch("https://proxy.internal/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({
              model: "anthropic.claude-sonnet-4-5",
              messages: [{ role: "user", content: "outer-after" }],
            }),
          });
        },
        async result() {
          return {
            role: "assistant",
            content: [{ type: "text", text: "outer ok" }],
            api: "openai-completions",
            provider: "aws-bedrock-proxy",
            model: "anthropic.claude-sonnet-4-5",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      }) as any,
    });

    globalThis.fetch = fetchMock;
    try {
      await withEnv("AWS_BEDROCK_PROXY_API_KEY", "test-key", async () => {
        await outerRuntime.runTurn(makeParams(outerConfig, {
          providerOptions: outerConfig.providerOptions as Record<string, unknown>,
        }));
      });

      const ttlByLabel = new Map(captured.map((entry) => [entry.label, entry.ttl]));
      expect(ttlByLabel.get("outer-before")).toBe("5m");
      expect(ttlByLabel.get("inner")).toBe("1h");
      expect(ttlByLabel.get("outer-after")).toBe("5m");
      expect(globalThis.fetch).toBe(fetchMock);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.serial("concurrent aws-bedrock-proxy runs do not leak prompt-caching context", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-fetch-concurrent-"));
    const captured: Array<{ label: string; ttl: PromptCachingTtl | null }> = [];
    const originalFetch = globalThis.fetch;
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = await parseProxyFetchPayload(input, init);
      if (request) captured.push(request);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    let waitingCount = 0;
    let releaseBarrier: (() => void) | null = null;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const waitForBothRuntimes = async () => {
      waitingCount += 1;
      if (waitingCount === 2) {
        releaseBarrier?.();
      }
      await barrier;
    };

    const runAConfig = makeConfig(homeDir, {
      provider: "aws-bedrock-proxy",
      model: "anthropic.claude-sonnet-4-5",
      preferredChildModel: "anthropic.claude-sonnet-4-5",
      awsBedrockProxyBaseUrl: "https://proxy.internal/v1",
      providerOptions: {
        "aws-bedrock-proxy": {
          promptCaching: {
            enabled: true,
            ttl: "5m",
          },
        },
      },
    });
    const runBConfig = makeConfig(homeDir, {
      provider: "aws-bedrock-proxy",
      model: "anthropic.claude-sonnet-4-5",
      preferredChildModel: "anthropic.claude-sonnet-4-5",
      awsBedrockProxyBaseUrl: "https://proxy.internal/v1",
      providerOptions: {
        "aws-bedrock-proxy": {
          promptCaching: {
            enabled: true,
            ttl: "1h",
          },
        },
      },
    });

    const runtimeA = createPiRuntime({
      piStreamImpl: () => ({
        async *[Symbol.asyncIterator]() {
          await waitForBothRuntimes();
          await fetch("https://proxy.internal/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({
              model: "anthropic.claude-sonnet-4-5",
              messages: [{ role: "user", content: "run-a" }],
            }),
          });
        },
        async result() {
          return {
            role: "assistant",
            content: [{ type: "text", text: "run-a ok" }],
            api: "openai-completions",
            provider: "aws-bedrock-proxy",
            model: "anthropic.claude-sonnet-4-5",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      }) as any,
    });

    const runtimeB = createPiRuntime({
      piStreamImpl: () => ({
        async *[Symbol.asyncIterator]() {
          await waitForBothRuntimes();
          await fetch("https://proxy.internal/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({
              model: "anthropic.claude-sonnet-4-5",
              messages: [{ role: "user", content: "run-b" }],
            }),
          });
        },
        async result() {
          return {
            role: "assistant",
            content: [{ type: "text", text: "run-b ok" }],
            api: "openai-completions",
            provider: "aws-bedrock-proxy",
            model: "anthropic.claude-sonnet-4-5",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      }) as any,
    });

    globalThis.fetch = fetchMock;
    try {
      await withEnv("AWS_BEDROCK_PROXY_API_KEY", "test-key", async () => {
        await Promise.all([
          runtimeA.runTurn(makeParams(runAConfig, {
            providerOptions: runAConfig.providerOptions as Record<string, unknown>,
          })),
          runtimeB.runTurn(makeParams(runBConfig, {
            providerOptions: runBConfig.providerOptions as Record<string, unknown>,
          })),
        ]);
      });

      const ttlByLabel = new Map(captured.map((entry) => [entry.label, entry.ttl]));
      expect(ttlByLabel.get("run-a")).toBe("5m");
      expect(ttlByLabel.get("run-b")).toBe("1h");
      expect(globalThis.fetch).toBe(fetchMock);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});
