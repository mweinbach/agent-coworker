import { describe, expect, test } from "bun:test";
import path from "node:path";

import { defaultModelForProvider, getModel, loadConfig } from "../../src/config";
import {
  DEFAULT_PROVIDER_OPTIONS,
  makeConfig,
  makeTmpDirs,
  repoRoot,
  withEnv,
  writeJson,
} from "./helpers";

const DEFAULT_CURSOR_MODEL = "composer-2.5";

describe(`Cursor Agent provider (${DEFAULT_CURSOR_MODEL})`, () => {
  test(`defaultModelForProvider returns ${DEFAULT_CURSOR_MODEL}`, () => {
    expect(defaultModelForProvider("cursor-agent")).toBe(DEFAULT_CURSOR_MODEL);
  });

  test("getModel creates cursor-agent adapter", () => {
    const cfg = makeConfig({ provider: "cursor-agent", model: DEFAULT_CURSOR_MODEL });
    const model = getModel(cfg);

    expect(model).toBeDefined();
    expect(model.modelId).toBe(DEFAULT_CURSOR_MODEL);
    expect(model.provider).toBe("cursor-agent.sdk");
    expect(model.specificationVersion).toBe("v3");
  });

  test("getModel exposes stable adapter shape", async () => {
    const { home } = await makeTmpDirs();
    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        "cursor-agent": {
          service: "cursor-agent",
          mode: "api_key",
          apiKey: "test_cursor_key",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await withEnv("HOME", home, async () => {
      const cfg = makeConfig({
        provider: "cursor-agent",
        model: DEFAULT_CURSOR_MODEL,
        userCoworkDir: path.join(home, ".cowork"),
      });
      const model = getModel(cfg, DEFAULT_CURSOR_MODEL) as {
        modelId: string;
        provider: string;
        specificationVersion: string;
        config: { headers: () => Promise<Record<string, string>> };
      };
      const headers = await model.config.headers();

      expect(model.modelId).toBe(DEFAULT_CURSOR_MODEL);
      expect(model.provider).toBe("cursor-agent.sdk");
      expect(model.specificationVersion).toBe("v3");
      expect(headers).toEqual({});
    });
  });

  test("cursor-agent provider options are configured", () => {
    const opts = DEFAULT_PROVIDER_OPTIONS["cursor-agent"];
    expect(opts).toBeDefined();
    expect(opts.thinking).toBe("high");
  });

  test(`loadConfig with cursor-agent provider returns ${DEFAULT_CURSOR_MODEL} model`, async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "cursor-agent" },
    });

    expect(cfg.provider).toBe("cursor-agent");
    expect(cfg.model).toBe(DEFAULT_CURSOR_MODEL);
    expect(cfg.runtime).toBe("cursor-sdk");
  });
});

describe("Cursor SDK runtime", () => {
  test("runs a turn through injected SDK agent and persists agentId", async () => {
    const { createCursorSdkRuntime } = await import("../../src/runtime/cursorSdkRuntime");
    const config = makeConfig({ provider: "cursor-agent", model: DEFAULT_CURSOR_MODEL });
    const rawEvents: unknown[] = [];
    const streamParts: unknown[] = [];
    const sentMessages: unknown[] = [];

    const runtime = createCursorSdkRuntime({
      resolveApiKey: () => "test-cursor-key",
      resolveEffectiveModelId: async () => DEFAULT_CURSOR_MODEL,
      createAgent: (async () => ({
        agentId: "agent-test-123",
        model: { id: DEFAULT_CURSOR_MODEL },
        send: async (
          message: unknown,
          options?: { onDelta?: (args: { update: unknown }) => void | Promise<void> },
        ) => {
          sentMessages.push(message);
          await options?.onDelta?.({
            update: {
              type: "turn-ended",
              usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          });
          return {
            id: "run-test-123",
            agentId: "agent-test-123",
            status: "finished",
            supports: () => true,
            unsupportedReason: () => undefined,
            onDidChangeStatus: () => () => {},
            cancel: async () => {},
            conversation: async () => [],
            wait: async () => ({
              id: "run-test-123",
              status: "finished",
              result: "cursor-agent-live-ok",
            }),
            stream: async function* () {
              yield {
                type: "assistant",
                agent_id: "agent-test-123",
                run_id: "run-test-123",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "cursor-agent-live-ok" }],
                },
              };
            },
          };
        },
        close: () => {},
        reload: async () => {},
        listArtifacts: async () => [],
        downloadArtifact: async () => Buffer.from(""),
      })) as never,
    });

    const result = await runtime.runTurn({
      config,
      system: "system prompt",
      messages: [{ role: "user", content: "Say ok" }],
      tools: {},
      maxSteps: 1,
      onModelRawEvent: (event) => rawEvents.push(event),
      onModelStreamPart: (part) => streamParts.push(part),
    });

    expect(sentMessages[0]).toBe("system prompt\nSay ok");
    expect(result.text).toBe("cursor-agent-live-ok");
    expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    expect(result.providerState).toMatchObject({
      provider: "cursor-agent",
      model: DEFAULT_CURSOR_MODEL,
      agentId: "agent-test-123",
    });
    expect(rawEvents).toHaveLength(1);
    expect(streamParts.some((part) => (part as { type?: string }).type === "text-delta")).toBe(
      true,
    );
  });
});
