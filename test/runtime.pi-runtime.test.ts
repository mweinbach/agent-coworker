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
      expiresAtMs: Date.now() + 60_000,
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
});
