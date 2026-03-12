import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getModels as getPiModels } from "@mariozechner/pi-ai";
import { z } from "zod";

import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";
import { getAiCoworkerPaths } from "../src/connect";
import { CODEX_BACKEND_BASE_URL, writeCodexAuthMaterial } from "../src/providers/codex-auth";
import { __internal as piRuntimeInternal, createPiRuntime } from "../src/runtime/piRuntime";
import { MODEL_SCRATCHPAD_DIRNAME } from "../src/shared/toolOutputOverflow";

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
    subAgentModel: "gpt-5.2",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(homeDir, ".agent-project"),
    userAgentDir: path.join(homeDir, ".agent"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [],
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
  const models = (getPiModels("openai-codex" as any) as Array<{ id?: string }> | undefined) ?? [];
  return models[0]?.id ?? "codex-mini-latest";
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
      subAgentModel: pickCodexModelId(),
    });

    const resolved = await piRuntimeInternal.resolvePiModel(makeParams(config));

    expect(resolved.apiKey).toBe("tok_live");
    expect(resolved.headers).toEqual({ "ChatGPT-Account-ID": "acct_123" });
    expect(resolved.model.baseUrl).toBe(CODEX_BACKEND_BASE_URL);
    expect(resolved.model.headers).toMatchObject({ "ChatGPT-Account-ID": "acct_123" });
  });

  test("codex runtime model resolution imports legacy ~/.codex auth into Cowork auth", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-codex-legacy-"));
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
      subAgentModel: pickCodexModelId(),
    });

    const resolved = await piRuntimeInternal.resolvePiModel(makeParams(config));

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

  test("opencode-go runtime model resolution returns explicit GLM-5 PI metadata", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-opencode-glm-"));
    const config = makeConfig(homeDir, {
      provider: "opencode-go",
      model: "glm-5",
      subAgentModel: "glm-5",
    });

    const resolved = await piRuntimeInternal.resolvePiModel(makeParams(config));

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
      subAgentModel: "kimi-k2.5",
    });

    const resolved = await piRuntimeInternal.resolvePiModel(makeParams(config));

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

  test("opencode-zen runtime model resolution returns explicit GLM-5 PI metadata and env-key fallback", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-opencode-zen-"));
    const config = makeConfig(homeDir, {
      provider: "opencode-zen",
      model: "glm-5",
      subAgentModel: "glm-5",
    });

    const previous = process.env.OPENCODE_ZEN_API_KEY;
    process.env.OPENCODE_ZEN_API_KEY = "env-opencode-zen-key";
    try {
      const resolved = await piRuntimeInternal.resolvePiModel(makeParams(config));

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
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_ZEN_API_KEY;
      } else {
        process.env.OPENCODE_ZEN_API_KEY = previous;
      }
    }
  });

  test("opencode-zen runtime model resolution returns explicit MiniMax M2.5 PI metadata", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-opencode-zen-minimax-"));
    const config = makeConfig(homeDir, {
      provider: "opencode-zen",
      model: "minimax-m2.5",
      subAgentModel: "glm-5",
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
    expect(spillPath).toContain(`/${MODEL_SCRATCHPAD_DIRNAME}/`);
    expect(String(overflowOutput.value)).toContain("Tool output overflowed");
    expect(String(overflowOutput.value)).toContain(spillPath);
    expect(Number(overflowOutput.chars)).toBeGreaterThan(80);
    expect(fileEvent.path).toBe(spillPath);
    expect(fileEvent.chars).toBe(overflowOutput.chars);
    expect(fileEvent.preview).toBe(overflowOutput.preview);

    const saved = await fs.readFile(spillPath, "utf-8");
    expect(saved).toBe(JSON.stringify(toolOutput, null, 2));

    expect(result.isError).toBe(false);
    expect(result.details).toEqual(overflowOutput);
    expect(result.content).toEqual([{ type: "text", text: String(overflowOutput.value) }]);
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

});
