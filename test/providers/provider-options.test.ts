import { describe, expect, test, mock, beforeEach } from "bun:test";
import path from "node:path";

import type { AgentConfig } from "../../src/types";
import type { RunTurnParams } from "../../src/agent";
import { createRunTurn } from "../../src/agent";
import { __internal as observabilityRuntimeInternal } from "../../src/observability/runtime";
import { DEFAULT_PROVIDER_OPTIONS, makeConfig } from "./helpers";

// ---------------------------------------------------------------------------
// Provider options structure and consistency
// ---------------------------------------------------------------------------
describe("Provider options structure", () => {
  test("all expected providers have options defined", () => {
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("openai");
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("google");
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("anthropic");
    expect(DEFAULT_PROVIDER_OPTIONS).toHaveProperty("codex-cli");
  });

  test("no extra unknown providers in options", () => {
    const providers = Object.keys(DEFAULT_PROVIDER_OPTIONS);
    expect(providers).toEqual([
      "openai",
      "google",
      "anthropic",
      "codex-cli",
    ]);
  });

  test("each provider options is a plain object", () => {
    for (const [, opts] of Object.entries(DEFAULT_PROVIDER_OPTIONS)) {
      expect(typeof opts).toBe("object");
      expect(opts).not.toBeNull();
      expect(Array.isArray(opts)).toBe(false);
    }
  });

  test("providerOptions can be attached to AgentConfig", () => {
    const cfg = makeConfig({ providerOptions: DEFAULT_PROVIDER_OPTIONS });
    expect(cfg.providerOptions).toEqual(DEFAULT_PROVIDER_OPTIONS);
  });

  test("providerOptions is optional on AgentConfig", () => {
    const cfg = makeConfig();
    expect(cfg.providerOptions).toBeUndefined();
  });

  test("provider defaults include reasoning/thinking profiles", () => {
    // OpenAI: reasoningEffort is "high"
    expect(DEFAULT_PROVIDER_OPTIONS.openai.reasoningEffort).toBe("high");

    // Google: thinkingConfig.includeThoughts is true
    expect(DEFAULT_PROVIDER_OPTIONS.google.thinkingConfig.includeThoughts).toBe(true);

    // Anthropic: thinking.type is "enabled"
    expect(DEFAULT_PROVIDER_OPTIONS.anthropic.thinking.type).toBe("enabled");
  });
});

// ---------------------------------------------------------------------------
// Agent runTurn providerOptions pass-through (real DI test)
// ---------------------------------------------------------------------------
describe("Agent providerOptions pass-through", () => {
  const mockStreamText = mock(async () => ({
    text: "hello from model",
    reasoningText: undefined as string | undefined,
    response: { messages: [{ role: "assistant", content: "hi" }] },
  }));

  const mockStepCountIs = mock((_n: number) => "step-count-sentinel");
  const mockGetModel = mock((_config: AgentConfig, _id?: string) => "model-sentinel");
  const mockCreateTools = mock((_ctx: any) => ({ bash: { type: "builtin" } }));
  const mockLoadMCPServers = mock(async (_config: AgentConfig) => [] as any[]);
  const mockLoadMCPTools = mock(async (_servers: any[], _opts?: any) => ({
    tools: {} as Record<string, any>,
    errors: [] as string[],
  }));

  let runTurn: ReturnType<typeof createRunTurn>;

  function makeRunTurnParams(overrides: Partial<RunTurnParams> = {}): RunTurnParams {
    return {
      config: makeConfig(),
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] as any[],
      log: mock(() => {}),
      askUser: mock(async () => "yes"),
      approveCommand: mock(async () => true),
      ...overrides,
    };
  }

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();

    mockStreamText.mockClear();
    mockStepCountIs.mockClear();
    mockGetModel.mockClear();
    mockCreateTools.mockClear();
    mockLoadMCPServers.mockClear();
    mockLoadMCPTools.mockClear();

    mockStreamText.mockImplementation(async () => ({
      text: "hello from model",
      reasoningText: undefined as string | undefined,
      response: { messages: [{ role: "assistant", content: "hi" }] },
    }));

    runTurn = createRunTurn({
      streamText: mockStreamText,
      stepCountIs: mockStepCountIs,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });
  });

  test("providerOptions from config is passed through to streamText", async () => {
    const providerOptions = { openai: { reasoningEffort: "high" } };
    const config = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions,
    });

    await runTurn(makeRunTurnParams({ config }));

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBe(providerOptions);
    expect(callArg.providerOptions.openai.reasoningEffort).toBe("high");
  });

  test("providerOptions is undefined in streamText when config has none", async () => {
    const config = makeConfig({ provider: "openai", model: "gpt-5.2" });
    delete config.providerOptions;

    await runTurn(makeRunTurnParams({ config }));

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBeUndefined();
  });

  test("full DEFAULT_PROVIDER_OPTIONS are forwarded to streamText", async () => {
    const config = makeConfig({
      provider: "anthropic",
      model: "claude-opus-4-6",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    await runTurn(makeRunTurnParams({ config }));

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBe(DEFAULT_PROVIDER_OPTIONS);
    expect(callArg.providerOptions.openai.reasoningEffort).toBe("high");
    expect(callArg.providerOptions.google.thinkingConfig.includeThoughts).toBe(true);
    expect(callArg.providerOptions.anthropic.thinking.type).toBe("enabled");
  });
});
