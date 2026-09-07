import { describe, expect, test } from "bun:test";

import {
  buildInitialStepMessages,
  matchingProviderState,
  messagesAfterLastAssistant,
  nextProviderState,
  supportsProviderManagedContinuation,
} from "../src/runtime/pi/stepState";
import type { PiModel } from "../src/runtime/piRuntimeOptions";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

function model(api: string): PiModel {
  return {
    id: "gpt-5.2",
    name: "gpt-5.2",
    api,
    provider: "openai",
    baseUrl: "https://api.openai.com",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function params(
  overrides: Partial<RuntimeRunTurnParams> & {
    provider?: AgentConfig["provider"];
    model?: string;
  } = {},
): RuntimeRunTurnParams {
  const { provider = "openai", model: modelId = "gpt-5.2", ...rest } = overrides;
  return {
    config: {
      provider,
      model: modelId,
      preferredChildModel: modelId,
      workingDirectory: "/tmp",
      outputDirectory: "/tmp/output",
      uploadsDirectory: "/tmp/uploads",
      userName: "",
      knowledgeCutoff: "unknown",
      projectCoworkDir: "/tmp/.cowork",
      userCoworkDir: "/tmp/.cowork",
      builtInDir: "/tmp/built-in",
      builtInConfigDir: "/tmp/built-in/config",
      skillsDirs: [],
      memoryDirs: [],
      configDirs: [],
    } as AgentConfig,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: {},
    maxSteps: 1,
    ...rest,
  };
}

const seed: ModelMessage[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: [{ type: "text", text: "ack" }] },
  { role: "user", content: "steer" },
];

describe("provider-managed continuation eligibility", () => {
  test("enables OpenAI and Codex Responses, and rejects other PI hosts", () => {
    expect(
      supportsProviderManagedContinuation(params({ provider: "openai" }), {
        model: model("openai-responses"),
      }),
    ).toBe(true);
    expect(
      supportsProviderManagedContinuation(params({ provider: "codex-cli" }), {
        model: model("openai-responses"),
      }),
    ).toBe(true);
    expect(
      supportsProviderManagedContinuation(params({ provider: "codex-cli" }), {
        model: model("openai-completions"),
      }),
    ).toBe(false);
    expect(
      supportsProviderManagedContinuation(params({ provider: "anthropic" }), {
        model: model("openai-responses"),
      }),
    ).toBe(false);
  });
});

describe("buildInitialStepMessages", () => {
  test("sends only the post-assistant delta when a matching continuation exists", () => {
    const run = params({
      messages: seed,
      allMessages: [{ role: "user", content: "full history" }, ...seed],
      providerState: {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_1",
        updatedAt: "2026-09-07T10:00:00.000Z",
      },
    });
    const resolved = { model: model("openai-responses") };
    expect(matchingProviderState(run, resolved)?.responseId).toBe("resp_1");
    expect(buildInitialStepMessages(run, resolved)).toEqual([{ role: "user", content: "steer" }]);
  });

  test("falls back to the current messages when the matching delta is empty", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    expect(
      buildInitialStepMessages(
        params({
          messages,
          providerState: {
            provider: "openai",
            model: "gpt-5.2",
            responseId: "resp_1",
            updatedAt: "2026-09-07T10:00:00.000Z",
          },
        }),
        { model: model("openai-responses") },
      ),
    ).toEqual(messages);
  });

  test("uses allMessages when provider state is missing or targets a different model", () => {
    const allMessages: ModelMessage[] = [{ role: "user", content: "full history" }, ...seed];
    const resolved = { model: model("openai-responses") };
    expect(buildInitialStepMessages(params({ messages: seed, allMessages }), resolved)).toEqual(
      allMessages,
    );
    expect(
      buildInitialStepMessages(
        params({
          messages: seed,
          allMessages,
          providerState: {
            provider: "openai",
            model: "gpt-4.1",
            responseId: "resp_stale",
            updatedAt: "2026-09-07T10:00:00.000Z",
          },
        }),
        resolved,
      ),
    ).toEqual(allMessages);
  });

  test("keeps the current messages for hosts that do not own provider continuation", () => {
    const allMessages: ModelMessage[] = [{ role: "user", content: "full history" }, ...seed];
    expect(
      buildInitialStepMessages(
        params({
          provider: "anthropic",
          messages: seed,
          allMessages,
          providerState: {
            provider: "openai",
            model: "gpt-5.2",
            responseId: "resp_1",
            updatedAt: "2026-09-07T10:00:00.000Z",
          },
        }),
        { model: model("openai-responses") },
      ),
    ).toEqual(seed);
  });
});

describe("nextProviderState", () => {
  test("persists a trimmed response id and account when continuation is enabled", () => {
    const state = nextProviderState(
      params({ provider: "codex-cli" }),
      { model: model("openai-responses"), accountId: "acct_1" },
      "  resp_2  ",
    );
    expect(state).toEqual({
      provider: "codex-cli",
      model: "gpt-5.2",
      responseId: "resp_2",
      accountId: "acct_1",
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  test("drops blank response ids and unsupported hosts", () => {
    const resolved = { model: model("openai-responses") };
    expect(nextProviderState(params(), resolved, "   ")).toBeUndefined();
    expect(nextProviderState(params(), resolved, "")).toBeUndefined();
    expect(
      nextProviderState(params({ provider: "anthropic" }), resolved, "resp_1"),
    ).toBeUndefined();
  });
});

describe("messagesAfterLastAssistant", () => {
  test("returns the suffix after the last assistant, or the full list when none exists", () => {
    expect(messagesAfterLastAssistant(seed)).toEqual([{ role: "user", content: "steer" }]);
    expect(messagesAfterLastAssistant([{ role: "user", content: "only" }])).toEqual([
      { role: "user", content: "only" },
    ]);
  });
});
