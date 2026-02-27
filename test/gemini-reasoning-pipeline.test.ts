import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";
import { DEFAULT_PROVIDER_OPTIONS } from "../src/providers";
import { __internal as piRuntimeInternal } from "../src/runtime/piRuntime";
import { buildPiStreamOptions, toGoogleThinkingLevel, providerSectionForPi } from "../src/runtime/piRuntimeOptions";
import {
  extractPiAssistantText,
  extractPiReasoningText,
  modelMessagesToPiMessages,
  piTurnMessagesToModelMessages,
} from "../src/runtime/piMessageBridge";
import { normalizeModelStreamPart, reasoningModeForProvider } from "../src/server/modelStream";
import { mapModelStreamChunk } from "../src/client/modelStream";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

import { makeTmpDirs, repoRoot } from "./providers/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3.1-pro-preview-customtools",
    subAgentModel: "gemini-3-flash-preview",
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

// ---------------------------------------------------------------------------
// 1. Pi Runtime: emitPiEventAsRawPart — Gemini thinking events
// ---------------------------------------------------------------------------
describe("Pi Runtime: Gemini thinking stream events", () => {
  test("thinking_start maps to reasoning-start with mode 'reasoning' for Google", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_start", contentIndex: 0 },
      "google",
      true,
      async (part) => { emitted.push(part as Record<string, unknown>); }
    );

    expect(emitted).toEqual([
      { type: "reasoning-start", id: "s0", mode: "reasoning" },
    ]);
  });

  test("thinking_delta maps to reasoning-delta with correct text for Google", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_delta", contentIndex: 0, delta: "I need to analyze the file structure..." },
      "google",
      true,
      async (part) => { emitted.push(part as Record<string, unknown>); }
    );

    expect(emitted).toEqual([
      {
        type: "reasoning-delta",
        id: "s0",
        mode: "reasoning",
        text: "I need to analyze the file structure...",
      },
    ]);
  });

  test("thinking_end maps to reasoning-end for Google", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_end", contentIndex: 0 },
      "google",
      true,
      async (part) => { emitted.push(part as Record<string, unknown>); }
    );

    expect(emitted).toEqual([
      { type: "reasoning-end", id: "s0", mode: "reasoning" },
    ]);
  });

  test("thinking events use 'summary' mode for OpenAI provider", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_start", contentIndex: 0 },
      "openai",
      true,
      async (part) => { emitted.push(part as Record<string, unknown>); }
    );

    expect(emitted[0]).toEqual({ type: "reasoning-start", id: "s0", mode: "summary" });
  });

  test("thinking events use 'reasoning' mode for Anthropic provider", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_start", contentIndex: 0 },
      "anthropic",
      true,
      async (part) => { emitted.push(part as Record<string, unknown>); }
    );

    expect(emitted[0]).toEqual({ type: "reasoning-start", id: "s0", mode: "reasoning" });
  });

  test("thinking_delta with empty delta emits empty string", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_delta", contentIndex: 0, delta: undefined },
      "google",
      true,
      async (part) => { emitted.push(part as Record<string, unknown>); }
    );

    expect(emitted).toEqual([
      { type: "reasoning-delta", id: "s0", mode: "reasoning", text: "" },
    ]);
  });

  test("full thinking lifecycle produces start → delta(s) → end", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const emit = async (part: unknown) => { emitted.push(part as Record<string, unknown>); };

    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_start", contentIndex: 0 },
      "google", true, emit
    );
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_delta", contentIndex: 0, delta: "Step 1: " },
      "google", true, emit
    );
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_delta", contentIndex: 0, delta: "Read the file" },
      "google", true, emit
    );
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_end", contentIndex: 0 },
      "google", true, emit
    );

    expect(emitted).toEqual([
      { type: "reasoning-start", id: "s0", mode: "reasoning" },
      { type: "reasoning-delta", id: "s0", mode: "reasoning", text: "Step 1: " },
      { type: "reasoning-delta", id: "s0", mode: "reasoning", text: "Read the file" },
      { type: "reasoning-end", id: "s0", mode: "reasoning" },
    ]);
  });

  test("thinking events with non-zero contentIndex use correct stream ID", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_start", contentIndex: 2 },
      "google",
      true,
      async (part) => { emitted.push(part as Record<string, unknown>); }
    );

    expect(emitted[0]).toEqual({ type: "reasoning-start", id: "s2", mode: "reasoning" });
  });
});

// ---------------------------------------------------------------------------
// 2. Pi Runtime Options: Google thinking config
// ---------------------------------------------------------------------------
describe("Pi Runtime Options: Google thinkingConfig", () => {
  test("Google thinkingConfig with includeThoughts=true produces enabled thinking", () => {
    const params = makeParams(makeConfig({
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "high",
          },
        },
      },
    }));

    const options = buildPiStreamOptions(params);
    expect(options.thinking).toEqual({
      enabled: true,
      level: "HIGH",
    });
  });

  test("Google thinkingConfig with thinkingBudget includes budgetTokens", () => {
    const params = makeParams(makeConfig({
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "medium",
            thinkingBudget: 8192,
          },
        },
      },
    }));

    const options = buildPiStreamOptions(params);
    expect(options.thinking).toEqual({
      enabled: true,
      level: "MEDIUM",
      budgetTokens: 8192,
    });
  });

  test("Google thinkingConfig with includeThoughts=false produces disabled thinking", () => {
    const params = makeParams(makeConfig({
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: false,
            thinkingLevel: "high",
          },
        },
      },
    }));

    const options = buildPiStreamOptions(params);
    expect(options.thinking).toEqual({
      enabled: false,
      level: "HIGH",
    });
  });

  test("Missing thinkingConfig does not produce thinking option", () => {
    const params = makeParams(makeConfig({
      providerOptions: { google: {} },
    }));

    const options = buildPiStreamOptions(params);
    expect(options.thinking).toBeUndefined();
  });

  test("toGoogleThinkingLevel normalizes case-insensitively", () => {
    expect(toGoogleThinkingLevel("high")).toBe("HIGH");
    expect(toGoogleThinkingLevel("HIGH")).toBe("HIGH");
    expect(toGoogleThinkingLevel("Medium")).toBe("MEDIUM");
    expect(toGoogleThinkingLevel("low")).toBe("LOW");
    expect(toGoogleThinkingLevel("MINIMAL")).toBe("MINIMAL");
    expect(toGoogleThinkingLevel("invalid")).toBeUndefined();
    expect(toGoogleThinkingLevel(undefined)).toBeUndefined();
    expect(toGoogleThinkingLevel("")).toBeUndefined();
  });

  test("providerSectionForPi returns google section for google provider", () => {
    const section = providerSectionForPi("google", {
      google: { thinkingConfig: { includeThoughts: true } },
    });
    expect(section).toEqual({ thinkingConfig: { includeThoughts: true } });
  });

  test("providerSectionForPi falls back to vertex section for google provider", () => {
    const section = providerSectionForPi("google", {
      vertex: { thinkingConfig: { includeThoughts: true } },
    });
    expect(section).toEqual({ thinkingConfig: { includeThoughts: true } });
  });
});

// ---------------------------------------------------------------------------
// 3. Pi Message Bridge: thinking ↔ reasoning round-trip
// ---------------------------------------------------------------------------
describe("Pi Message Bridge: Gemini thinking round-trip", () => {
  test("assistant thinking parts map to 'reasoning' type in model messages", () => {
    const piTurnMessages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me analyze this code carefully." },
          { type: "text", text: "Here's the analysis." },
        ],
      },
    ] as any[];

    const modelMessages = piTurnMessagesToModelMessages(piTurnMessages);
    expect(modelMessages).toHaveLength(1);
    const content = (modelMessages[0] as any).content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "reasoning", text: "Let me analyze this code carefully." });
    expect(content[1]).toEqual({ type: "text", text: "Here's the analysis." });
  });

  test("model reasoning parts map back to 'thinking' type in pi messages", () => {
    const modelMessages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Deep thinking about the problem." },
          { type: "text", text: "My conclusion." },
        ],
      },
    ] as ModelMessage[];

    const piMessages = modelMessagesToPiMessages(modelMessages, "google");
    expect(piMessages).toHaveLength(1);
    const content = (piMessages[0] as any).content;
    expect(content.some((p: any) => p.type === "thinking" && p.thinking === "Deep thinking about the problem.")).toBe(true);
    expect(content.some((p: any) => p.type === "text" && p.text === "My conclusion.")).toBe(true);
  });

  test("extractPiReasoningText extracts thinking from Gemini-style assistant response", () => {
    const piMessages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "First, I'll check the imports." },
          { type: "text", text: "The code looks good." },
          { type: "thinking", thinking: "Wait, there's a potential issue with error handling." },
        ],
      },
    ] as any[];

    const reasoning = extractPiReasoningText(piMessages);
    expect(reasoning).toBe("First, I'll check the imports.\n\nWait, there's a potential issue with error handling.");
  });

  test("extractPiAssistantText ignores thinking parts", () => {
    const piMessages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Internal reasoning..." },
          { type: "text", text: "Here's the final answer." },
        ],
      },
    ] as any[];

    const text = extractPiAssistantText(piMessages);
    expect(text).toBe("Here's the final answer.");
  });

  test("extractPiReasoningText returns undefined when no thinking parts", () => {
    const piMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Just text, no thinking." },
        ],
      },
    ] as any[];

    expect(extractPiReasoningText(piMessages)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Server Model Stream: reasoning normalization for Google
// ---------------------------------------------------------------------------
describe("Server Model Stream: Google reasoning normalization", () => {
  test("reasoningModeForProvider returns 'reasoning' for google", () => {
    expect(reasoningModeForProvider("google")).toBe("reasoning");
  });

  test("reasoning-start normalized with mode=reasoning for google", () => {
    const result = normalizeModelStreamPart(
      { type: "reasoning-start", id: "rs-google", providerMetadata: { model: "gemini-3.1-pro" } },
      { provider: "google" }
    );
    expect(result).toEqual({
      partType: "reasoning_start",
      part: { id: "rs-google", mode: "reasoning", providerMetadata: { model: "gemini-3.1-pro" } },
    });
  });

  test("reasoning-delta normalized with mode=reasoning and text for google", () => {
    const result = normalizeModelStreamPart(
      { type: "reasoning-delta", id: "rd-google", text: "Analyzing the codebase..." },
      { provider: "google" }
    );
    expect(result).toEqual({
      partType: "reasoning_delta",
      part: { id: "rd-google", mode: "reasoning", text: "Analyzing the codebase..." },
    });
  });

  test("reasoning-end normalized with mode=reasoning for google", () => {
    const result = normalizeModelStreamPart(
      { type: "reasoning-end", id: "re-google" },
      { provider: "google" }
    );
    expect(result).toEqual({
      partType: "reasoning_end",
      part: { id: "re-google", mode: "reasoning" },
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Client Model Stream: reasoning chunk mapping
// ---------------------------------------------------------------------------
describe("Client Model Stream: reasoning chunk mapping for Gemini", () => {
  const base = {
    type: "model_stream_chunk" as const,
    sessionId: "s1",
    turnId: "t1",
    provider: "google" as const,
    model: "gemini-3.1-pro-preview",
  };

  function chunk(partType: any, part: Record<string, unknown>, index = 0) {
    return { ...base, index, partType, part };
  }

  test("reasoning_start maps to reasoning_start with reasoning mode", () => {
    const result = mapModelStreamChunk(chunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    expect(result).toEqual({
      kind: "reasoning_start",
      turnId: "t1",
      streamId: "r1",
      mode: "reasoning",
    });
  });

  test("reasoning_delta maps to reasoning_delta with text", () => {
    const result = mapModelStreamChunk(chunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "thinking about it..." }));
    expect(result).toEqual({
      kind: "reasoning_delta",
      turnId: "t1",
      streamId: "r1",
      mode: "reasoning",
      text: "thinking about it...",
    });
  });

  test("reasoning_end maps to reasoning_end", () => {
    const result = mapModelStreamChunk(chunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    expect(result).toEqual({
      kind: "reasoning_end",
      turnId: "t1",
      streamId: "r1",
      mode: "reasoning",
    });
  });

  test("reasoning_delta without text maps to unknown", () => {
    const result = mapModelStreamChunk(chunk("reasoning_delta", { id: "r1", mode: "reasoning" }));
    expect(result?.kind).toBe("unknown");
  });

  test("reasoning_start defaults mode to 'reasoning' when mode is not 'summary'", () => {
    const result = mapModelStreamChunk(chunk("reasoning_start", { id: "r1" }));
    expect(result?.mode).toBe("reasoning");
  });
});

// ---------------------------------------------------------------------------
// 6. End-to-end: Gemini thinking event → normalized → client mapping
// ---------------------------------------------------------------------------
describe("End-to-end: Gemini thinking pipeline", () => {
  test("Pi thinking_start → server normalization → client mapping", async () => {
    // Step 1: Pi-AI emits a thinking_start event
    const piEmitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_start", contentIndex: 0 },
      "google", true,
      async (part) => { piEmitted.push(part as Record<string, unknown>); }
    );

    // Step 2: Server normalizes the raw part
    const normalized = normalizeModelStreamPart(piEmitted[0], { provider: "google" });
    expect(normalized.partType).toBe("reasoning_start");
    expect(normalized.part.mode).toBe("reasoning");

    // Step 3: Client maps the normalized chunk
    const clientMapped = mapModelStreamChunk({
      type: "model_stream_chunk",
      sessionId: "s1",
      turnId: "t1",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      index: 0,
      partType: normalized.partType as any,
      part: normalized.part,
    });
    expect(clientMapped?.kind).toBe("reasoning_start");
    expect((clientMapped as any)?.mode).toBe("reasoning");
  });

  test("Pi thinking_delta → server normalization → client mapping", async () => {
    const piEmitted: Array<Record<string, unknown>> = [];
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_delta", contentIndex: 0, delta: "Checking the imports..." },
      "google", true,
      async (part) => { piEmitted.push(part as Record<string, unknown>); }
    );

    const normalized = normalizeModelStreamPart(piEmitted[0], { provider: "google" });
    expect(normalized.partType).toBe("reasoning_delta");
    expect(normalized.part.text).toBe("Checking the imports...");

    const clientMapped = mapModelStreamChunk({
      type: "model_stream_chunk",
      sessionId: "s1",
      turnId: "t1",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      index: 1,
      partType: normalized.partType as any,
      part: normalized.part,
    });
    expect(clientMapped?.kind).toBe("reasoning_delta");
    expect((clientMapped as any)?.text).toBe("Checking the imports...");
    expect((clientMapped as any)?.mode).toBe("reasoning");
  });

  test("Full thinking lifecycle produces correct feed-ready events", async () => {
    const piEmitted: Array<Record<string, unknown>> = [];
    const emit = async (part: unknown) => { piEmitted.push(part as Record<string, unknown>); };

    // Simulate full thinking lifecycle from Pi-AI SDK
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_start", contentIndex: 0 }, "google", true, emit
    );
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_delta", contentIndex: 0, delta: "Step 1: " }, "google", true, emit
    );
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_delta", contentIndex: 0, delta: "Read the file. " }, "google", true, emit
    );
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_delta", contentIndex: 0, delta: "Step 2: Analyze structure." }, "google", true, emit
    );
    await piRuntimeInternal.emitPiEventAsRawPart(
      { type: "thinking_end", contentIndex: 0 }, "google", true, emit
    );

    // All events should be reasoning type with consistent id
    expect(piEmitted).toHaveLength(5);
    expect(piEmitted.every((e) => (e.id as string) === "s0")).toBe(true);
    expect(piEmitted.every((e) => (e.mode as string) === "reasoning")).toBe(true);

    // Normalize all through server pipeline
    const normalized = piEmitted.map((e) => normalizeModelStreamPart(e, { provider: "google" }));
    expect(normalized[0].partType).toBe("reasoning_start");
    expect(normalized[1].partType).toBe("reasoning_delta");
    expect(normalized[2].partType).toBe("reasoning_delta");
    expect(normalized[3].partType).toBe("reasoning_delta");
    expect(normalized[4].partType).toBe("reasoning_end");

    // All normalized deltas should carry the accumulated text
    expect(normalized[1].part.text).toBe("Step 1: ");
    expect(normalized[2].part.text).toBe("Read the file. ");
    expect(normalized[3].part.text).toBe("Step 2: Analyze structure.");
  });
});

// ---------------------------------------------------------------------------
// 7. Config: defaults.json includes providerOptions
// ---------------------------------------------------------------------------
describe("Config: defaults.json providerOptions", () => {
  test("loadConfig picks up google thinkingConfig from defaults.json", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions!.google).toBeDefined();
    expect(cfg.providerOptions!.google.thinkingConfig).toBeDefined();
    expect(cfg.providerOptions!.google.thinkingConfig.includeThoughts).toBe(true);
    expect(cfg.providerOptions!.google.thinkingConfig.thinkingLevel).toBe("high");
  });

  test("loadConfig picks up all provider reasoning options from defaults.json", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    // OpenAI options
    expect(cfg.providerOptions!.openai).toBeDefined();
    expect(cfg.providerOptions!.openai.reasoningEffort).toBe("high");
    expect(cfg.providerOptions!.openai.reasoningSummary).toBe("detailed");

    // Anthropic options
    expect(cfg.providerOptions!.anthropic).toBeDefined();
    expect(cfg.providerOptions!.anthropic.thinking.type).toBe("enabled");
    expect(cfg.providerOptions!.anthropic.thinking.budgetTokens).toBe(32000);

    // Codex-CLI options
    expect(cfg.providerOptions!["codex-cli"]).toBeDefined();
    expect(cfg.providerOptions!["codex-cli"].reasoningEffort).toBe("high");
  });

  test("DEFAULT_PROVIDER_OPTIONS matches defaults.json for google thinkingConfig", () => {
    // Ensure the programmatic defaults are consistent with the config file
    expect(DEFAULT_PROVIDER_OPTIONS.google.thinkingConfig.includeThoughts).toBe(true);
    expect(DEFAULT_PROVIDER_OPTIONS.google.thinkingConfig.thinkingLevel).toBe("high");
  });
});
