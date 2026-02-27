import { describe, expect, test } from "bun:test";
import { z } from "zod";

import * as __internal from "../src/runtime/piRuntimeOptions";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5.2",
    subAgentModel: "gpt-5.2",
    workingDirectory: "/tmp",
    outputDirectory: "/tmp/output",
    uploadsDirectory: "/tmp/uploads",
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: "/tmp/.agent",
    userAgentDir: "/tmp/.agent-user",
    builtInDir: "/tmp/built-in",
    builtInConfigDir: "/tmp/built-in/config",
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function makeParams(config: AgentConfig): RuntimeRunTurnParams {
  return {
    config,
    system: "system",
    messages: [{ role: "user", content: "hello" }] as ModelMessage[],
    tools: {},
    maxSteps: 1,
    providerOptions: config.providerOptions,
  };
}

describe("pi runtime provider option mapping", () => {
  test("maps openai reasoning options", () => {
    const params = makeParams(makeConfig({
      provider: "openai",
      providerOptions: {
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          textVerbosity: "low",
          temperature: 0.2,
        },
      },
    }));
    const mapped = __internal.buildPiStreamOptions(params);
    expect(mapped.reasoningEffort).toBe("high");
    expect(mapped.reasoningSummary).toBe("detailed");
    expect(mapped.textVerbosity).toBe("low");
    expect(mapped.temperature).toBe(0.2);
  });

  test("maps anthropic thinking options", () => {
    const params = makeParams(makeConfig({
      provider: "anthropic",
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 4096 },
          effort: "high",
          interleavedThinking: true,
        },
      },
    }));
    const mapped = __internal.buildPiStreamOptions(params);
    expect(mapped.thinkingEnabled).toBe(true);
    expect(mapped.thinkingBudgetTokens).toBe(4096);
    expect(mapped.effort).toBe("high");
    expect(mapped.interleavedThinking).toBe(true);
  });

  test("maps google thinking config options", () => {
    const params = makeParams(makeConfig({
      provider: "google",
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "high",
            thinkingBudget: 123,
          },
          temperature: 0.6,
          toolChoice: "auto",
        },
      },
    }));
    const mapped = __internal.buildPiStreamOptions(params);
    expect(mapped.thinking).toEqual({
      enabled: true,
      level: "HIGH",
      budgetTokens: 123,
    });
    expect(mapped.temperature).toBe(0.6);
    expect(mapped.toolChoice).toBe("auto");
  });

  test("uses codex-cli options with openai fallback", () => {
    const codexParams = makeParams(makeConfig({
      provider: "codex-cli",
      providerOptions: {
        "codex-cli": { reasoningEffort: "minimal" },
      },
    }));
    expect(__internal.providerSectionForPi("codex-cli", codexParams.providerOptions)).toEqual({
      reasoningEffort: "minimal",
    });

    const fallbackParams = makeParams(makeConfig({
      provider: "codex-cli",
      providerOptions: {
        openai: { reasoningEffort: "low" },
      },
    }));
    expect(__internal.providerSectionForPi("codex-cli", fallbackParams.providerOptions)).toEqual({
      reasoningEffort: "low",
    });
  });

  test("includes explicit stream headers when provided", () => {
    const params = makeParams(makeConfig({ provider: "codex-cli" }));
    const mapped = __internal.buildPiStreamOptions(
      params,
      "token-123",
      { "ChatGPT-Account-ID": "acct_123" }
    ) as any;

    expect(mapped.apiKey).toBe("token-123");
    expect(mapped.headers).toEqual({ "ChatGPT-Account-ID": "acct_123" });
  });

  test("converts zod tool schemas into json schema", () => {
    const schema = z.object({
      path: z.string(),
      recursive: z.boolean().optional(),
    });
    const jsonSchema = __internal.toPiJsonSchema(schema) as any;
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties.path.type).toBe("string");
    expect(jsonSchema.$schema).toBeUndefined();
  });
});
