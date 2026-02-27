import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getModels as getPiModels } from "@mariozechner/pi-ai";

import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";
import { getAiCoworkerPaths } from "../src/connect";
import { CODEX_BACKEND_BASE_URL, writeCodexAuthMaterial } from "../src/providers/codex-auth";
import { __internal as piRuntimeInternal, createPiRuntime } from "../src/runtime/piRuntime";

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
});
