import { describe, expect, test } from "bun:test";
import { z } from "zod";

import * as __internal from "../src/runtime/piRuntimeOptions";
import { __internal as piRuntimeInternal } from "../src/runtime/piRuntime";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5.2",
    preferredChildModel: "gpt-5.2",
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

  test("google provider options are not mapped in PI runtime (handled by Google Interactions runtime)", () => {
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
    // Google-specific options are no longer mapped through PI runtime
    expect(mapped.thinking).toBeUndefined();
    expect(mapped.temperature).toBeUndefined();
    expect(mapped.toolChoice).toBeUndefined();
  });

  test("ignores baseten providerOptions until they are exposed through the shared editable contract", () => {
    const params = makeParams(makeConfig({
      provider: "baseten",
      model: "moonshotai/Kimi-K2.5",
      preferredChildModel: "moonshotai/Kimi-K2.5",
      providerOptions: {
        baseten: {
          reasoningEffort: "high",
          temperature: 0.4,
          toolChoice: "auto",
        },
      },
    }));
    const mapped = __internal.buildPiStreamOptions(params);
    expect(mapped.reasoningEffort).toBeUndefined();
    expect(mapped.temperature).toBeUndefined();
    expect(mapped.toolChoice).toBeUndefined();
  });

  test("ignores together providerOptions until they are exposed through the shared editable contract", () => {
    const params = makeParams(makeConfig({
      provider: "together",
      model: "moonshotai/Kimi-K2.5",
      preferredChildModel: "moonshotai/Kimi-K2.5",
      providerOptions: {
        together: {
          reasoningEffort: "high",
          temperature: 0.4,
          toolChoice: "auto",
        },
      },
    }));
    const mapped = __internal.buildPiStreamOptions(params);
    expect(mapped.reasoningEffort).toBeUndefined();
    expect(mapped.temperature).toBeUndefined();
    expect(mapped.toolChoice).toBeUndefined();
  });

  test("forces NVIDIA reasoning on and ignores manual providerOptions", () => {
    const params = makeParams(makeConfig({
      provider: "nvidia",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredChildModel: "nvidia/nemotron-3-super-120b-a12b",
      providerOptions: {
        nvidia: {
          reasoningEffort: "none",
          temperature: 0.1,
          maxTokens: 1024,
        },
      },
    }));
    const mapped = __internal.buildPiStreamOptions(params);
    expect(mapped.reasoningEffort).toBe("high");
    expect(mapped.temperature).toBeUndefined();
    expect(mapped.maxTokens).toBeUndefined();
  });

  test("maps Bedrock provider options into PI stream options", () => {
    const params = makeParams(makeConfig({
      provider: "bedrock",
      model: "amazon.nova-lite-v1:0",
      preferredChildModel: "amazon.nova-lite-v1:0",
      providerOptions: {
        bedrock: {
          region: "us-west-2",
          profile: "sandbox",
          toolChoice: { type: "tool", name: "webSearch" },
          reasoning: "medium",
          thinkingBudgets: {
            low: 1024,
            medium: 4096,
          },
          interleavedThinking: false,
          requestMetadata: {
            environment: "dev",
            team: "core",
          },
          temperature: 0.3,
          maxTokens: 2048,
        },
      },
    }));

    const mapped = __internal.buildPiStreamOptions(params) as any;
    expect(mapped.region).toBe("us-west-2");
    expect(mapped.profile).toBe("sandbox");
    expect(mapped.toolChoice).toEqual({ type: "tool", name: "webSearch" });
    expect(mapped.reasoning).toBe("medium");
    expect(mapped.thinkingBudgets).toEqual({ low: 1024, medium: 4096 });
    expect(mapped.interleavedThinking).toBe(false);
    expect(mapped.requestMetadata).toEqual({ environment: "dev", team: "core" });
    expect(mapped.temperature).toBe(0.3);
    expect(mapped.maxTokens).toBe(2048);
  });

  test("uses codex-cli options with openai fallback", () => {
    const codexParams = makeParams(makeConfig({
      provider: "codex-cli",
      providerOptions: {
        "codex-cli": { reasoningEffort: "xhigh" },
      },
    }));
    expect(__internal.providerSectionForPi("codex-cli", codexParams.providerOptions)).toEqual({
      reasoningEffort: "xhigh",
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

  test("maps codex native web search options into PI stream options", () => {
    const params = makeParams(makeConfig({
      provider: "codex-cli",
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "high",
          webSearchBackend: "native",
          webSearchMode: "live",
          webSearch: {
            contextSize: "medium",
            allowedDomains: ["openai.com", "example.com"],
            location: {
              country: "US",
              city: "New York",
              timezone: "America/New_York",
            },
          },
        },
      },
    }));

    const mapped = __internal.buildPiStreamOptions(params) as any;
    expect(mapped.reasoningEffort).toBe("high");
    expect(mapped.webSearchBackend).toBe("native");
    expect(mapped.webSearchMode).toBe("live");
    expect(mapped.webSearchContextSize).toBe("medium");
    expect(mapped.webSearchAllowedDomains).toEqual(["openai.com", "example.com"]);
    expect(mapped.webSearchLocation).toEqual({
      country: "US",
      city: "New York",
      timezone: "America/New_York",
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

  test("builds supported OpenAI continuation request options", () => {
    expect(__internal.buildOpenAiContinuationRequestOptions("resp_123")).toEqual({
      truncation: "auto",
      previous_response_id: "resp_123",
    });
    expect(__internal.buildOpenAiContinuationRequestOptions(undefined)).toEqual({
      truncation: "auto",
    });
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

  test("normalizes tuple array items into provider-safe json schema", () => {
    const jsonSchema = __internal.toPiJsonSchema({
      type: "object",
      properties: {
        position: {
          type: "array",
          items: [
            { type: "number" },
            { type: "number" },
          ],
          additionalItems: false,
        },
      },
      required: ["position"],
    }) as any;

    expect(Array.isArray(jsonSchema.properties.position.items)).toBe(false);
    expect(jsonSchema.properties.position.items).toEqual({ type: "number" });
    expect(jsonSchema.properties.position.maxItems).toBe(2);
    expect(jsonSchema.properties.position.additionalItems).toBeUndefined();
  });

  test("drops Fireworks-unsupported length and pattern constraints from tool schemas", () => {
    const schema = z.object({
      filePath: z.string().min(1),
      content: z.string().max(2_000_000),
    });

    const jsonSchema = __internal.toPiJsonSchema(schema, "fireworks") as any;
    expect(jsonSchema.properties.filePath.minLength).toBeUndefined();
    expect(jsonSchema.properties.content.maxLength).toBeUndefined();

    const patterned = __internal.toPiJsonSchema({
      type: "object",
      properties: {
        color: {
          type: "string",
          pattern: "^#[0-9a-fA-F]{6}$",
        },
      },
    }, "fireworks") as any;
    expect(patterned.properties.color.pattern).toBeUndefined();
  });

  test("rewrites Fireworks oneOf schemas to anyOf", () => {
    const jsonSchema = __internal.toPiJsonSchema({
      type: "object",
      properties: {
        value: {
          oneOf: [
            { type: "string" },
            { type: "number" },
          ],
        },
      },
    }, "fireworks") as any;

    expect(jsonSchema.properties.value.oneOf).toBeUndefined();
    expect(jsonSchema.properties.value.anyOf).toEqual([
      { type: "string" },
      { type: "number" },
    ]);
  });

  test("keeps small Fireworks tool schemas intact when they fit the provider budget", () => {
    const tools = {
      readFile: {
        description: "simple tool",
        inputSchema: z.object({
          filePath: z.string(),
          limit: z.number().optional(),
        }),
      },
    };

    const fireworksTools = piRuntimeInternal.toolMapToPiTools(tools as any, "fireworks") as any[];
    expect(fireworksTools[0]?.parameters).toMatchObject({
      type: "object",
      properties: {
        filePath: { type: "string" },
        limit: { type: "number" },
      },
      required: ["filePath"],
    });
    expect(fireworksTools[0]?.parameters.additionalProperties).toBe(false);
  });

  test("degrades oversized Fireworks tool schemas to a shallow object shape", () => {
    const tools = {
      giantTool: {
        description: "tool with a very large enum schema",
        inputSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              enum: Array.from({ length: 160 }, (_, index) => `option-${index}-${"x".repeat(12)}`),
            },
          },
          required: ["choice"],
          additionalProperties: false,
        },
      },
    };

    const fireworksTools = piRuntimeInternal.toolMapToPiTools(tools as any, "fireworks") as any[];
    expect(fireworksTools[0]?.parameters).toEqual({
      type: "object",
      properties: {
        choice: {},
      },
      required: ["choice"],
      additionalProperties: true,
    });
  });

  test("degrades to the fully relaxed schema when the shallow Fireworks fallback still exceeds budget", () => {
    const propertyEntries = Array.from({ length: 100 }, (_, index) => {
      const key = `property-${index}-${"x".repeat(48)}`;
      return [
        key,
        {
          type: "string",
          enum: Array.from({ length: 24 }, (__unused, enumIndex) => `value-${enumIndex}-${"y".repeat(24)}`),
        },
      ] as const;
    });
    const giantSchema = {
      type: "object",
      properties: Object.fromEntries(propertyEntries),
      required: propertyEntries.map(([key]) => key),
      additionalProperties: false,
    };
    const tools = {
      giantTool: {
        description: "tool with many long property names",
        inputSchema: giantSchema,
      },
    };

    const fireworksTools = piRuntimeInternal.toolMapToPiTools(tools as any, "fireworks") as any[];
    expect(fireworksTools[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });

  test("degrades Fireworks tool schemas once the cumulative schema budget is exhausted", () => {
    const sharedSchema = {
      type: "object",
      properties: {
        choice: {
          type: "string",
          enum: Array.from({ length: 150 }, (_, index) => `option-${index}-${"x".repeat(12)}`),
        },
      },
      required: ["choice"],
      additionalProperties: false,
    };
    const tools = {
      firstTool: { description: "first", inputSchema: sharedSchema },
      secondTool: { description: "second", inputSchema: sharedSchema },
      thirdTool: { description: "third", inputSchema: sharedSchema },
      fourthTool: { description: "fourth", inputSchema: sharedSchema },
    };

    const fireworksTools = piRuntimeInternal.toolMapToPiTools(tools as any, "fireworks") as any[];
    expect(fireworksTools[0]?.parameters.properties.choice.enum).toHaveLength(150);
    expect(fireworksTools[1]?.parameters.properties.choice.enum).toHaveLength(150);
    expect(fireworksTools[2]?.parameters.properties.choice.enum).toHaveLength(150);
    expect(fireworksTools[3]?.parameters).toEqual({
      type: "object",
      properties: {
        choice: {},
      },
      required: ["choice"],
      additionalProperties: true,
    });
  });

  test("keeps oversized tool schemas for non-Fireworks providers", () => {
    const hugeEnum = Array.from({ length: 4000 }, (_, index) => `option-${index}`);
    const tools = {
      giantTool: {
        description: "tool with a very large enum schema",
        inputSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              enum: hugeEnum,
            },
          },
          required: ["choice"],
          additionalProperties: false,
        },
      },
    };

    const openAiTools = piRuntimeInternal.toolMapToPiTools(tools as any, "openai") as any[];
    expect(openAiTools[0]?.parameters.properties.choice.enum).toHaveLength(4000);
  });
});
