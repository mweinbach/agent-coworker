import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import type { RunTurnParams } from "../../src/agent";
import { createRunTurn } from "../../src/agent";
import { __internal as observabilityRuntimeInternal } from "../../src/observability/runtime";
import type { RuntimeRunTurnParams, RuntimeRunTurnResult } from "../../src/runtime/types";
import type { AgentConfig } from "../../src/types";
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
    expect(providers).toEqual(["openai", "google", "anthropic", "codex-cli"]);
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
    expect(DEFAULT_PROVIDER_OPTIONS.openai.textVerbosity).toBe("medium");

    // Google: thinkingConfig.includeThoughts is true
    expect(DEFAULT_PROVIDER_OPTIONS.google.thinkingConfig.includeThoughts).toBe(true);

    // Anthropic: Claude Opus 4.8 uses adaptive thinking with effort.
    expect(DEFAULT_PROVIDER_OPTIONS.anthropic.thinking.type).toBe("adaptive");
    expect(DEFAULT_PROVIDER_OPTIONS.anthropic.effort).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Agent runTurn providerOptions pass-through (real DI test)
// ---------------------------------------------------------------------------
describe("Agent providerOptions pass-through", () => {
  const mockRuntimeRunTurn = mock(
    async (_params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => ({
      text: "hello from model",
      reasoningText: undefined as string | undefined,
      responseMessages: [{ role: "assistant", content: "hi" }],
    }),
  );
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
      // Provider option forwarding is independent of the managed artifact runtime.
      // Keep this unit test isolated from any runtime installed in the developer's home.
      toolEnv: { COWORK_DISABLE_RUNTIME: "1" },
      ...overrides,
    };
  }

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();

    mockRuntimeRunTurn.mockClear();
    mockCreateTools.mockClear();
    mockLoadMCPServers.mockClear();
    mockLoadMCPTools.mockClear();

    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "hello from model",
      reasoningText: undefined as string | undefined,
      responseMessages: [{ role: "assistant", content: "hi" }],
    }));

    runTurn = createRunTurn({
      createRuntime: () => ({ name: "pi", runTurn: mockRuntimeRunTurn }),
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });
  });

  test("providerOptions from config is passed through to the runtime", async () => {
    const providerOptions = { openai: { reasoningEffort: "high" } };
    const config = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions,
    });

    await runTurn(makeRunTurnParams({ config }));

    expect(mockRuntimeRunTurn).toHaveBeenCalledTimes(1);
    const callArg = mockRuntimeRunTurn.mock.calls[0][0];
    expect(callArg.providerOptions).toBe(providerOptions);
    expect(callArg.providerOptions.openai.reasoningEffort).toBe("high");
  });

  test("providerOptions is undefined in the runtime when config has none", async () => {
    const config = makeConfig({ provider: "openai", model: "gpt-5.2" });
    delete config.providerOptions;

    await runTurn(makeRunTurnParams({ config }));

    expect(mockRuntimeRunTurn).toHaveBeenCalledTimes(1);
    const callArg = mockRuntimeRunTurn.mock.calls[0][0];
    expect(callArg.providerOptions).toBeUndefined();
  });

  test("full DEFAULT_PROVIDER_OPTIONS are forwarded to the runtime", async () => {
    const config = makeConfig({
      provider: "anthropic",
      model: "claude-opus-4-8",
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
    });

    await runTurn(makeRunTurnParams({ config }));

    expect(mockRuntimeRunTurn).toHaveBeenCalledTimes(1);
    const callArg = mockRuntimeRunTurn.mock.calls[0][0];
    expect(callArg.providerOptions).toBe(DEFAULT_PROVIDER_OPTIONS);
    expect(callArg.providerOptions.openai.reasoningEffort).toBe("high");
    expect(callArg.providerOptions.google.thinkingConfig.includeThoughts).toBe(true);
    expect(callArg.providerOptions.anthropic.thinking.type).toBe("adaptive");
    expect(callArg.providerOptions.anthropic.effort).toBe("high");
  });
});
