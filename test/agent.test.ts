import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import path from "node:path";

import type { AgentConfig } from "../src/types";
import type { RunTurnParams } from "../src/agent";
import { createRunTurn } from "../src/agent";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = "/tmp/agent-test";
  return {
    provider: "google",
    model: "gemini-2.0-flash",
    subAgentModel: "gemini-2.0-flash",
    workingDirectory: base,
    outputDirectory: path.join(base, "output"),
    uploadsDirectory: path.join(base, "uploads"),
    userName: "tester",
    knowledgeCutoff: "2025-01",
    projectAgentDir: path.join(base, ".agent"),
    userAgentDir: path.join(base, ".agent-user"),
    builtInDir: base,
    builtInConfigDir: path.join(base, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mocks -- we mock the heavy external dependencies so the tests are fast
// and deterministic.  We use mock.module() for each dependency.
// ---------------------------------------------------------------------------

const mockStreamText = mock(async () => ({
  text: "hello from model",
  reasoningText: undefined as string | undefined,
  response: { messages: [{ role: "assistant", content: "hi" }] },
}));

const mockStepCountIs = mock((_n: number) => "step-count-sentinel");

const mockGetModel = mock((_config: AgentConfig, _id?: string) => "model-sentinel");

const mockCreateTools = mock((_ctx: any) => ({
  bash: { type: "builtin" },
  read: { type: "builtin" },
}));

const mockLoadMCPServers = mock(async (_config: AgentConfig) => [] as any[]);
const mockLoadMCPTools = mock(async (_servers: any[], _opts?: any) => ({
  tools: {} as Record<string, any>,
  errors: [] as string[],
}));

// ---------------------------------------------------------------------------
// Factory for default RunTurnParams
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<RunTurnParams> = {}): RunTurnParams {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTurn", () => {
  let runTurn: typeof import("../src/agent").runTurn;

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();

    mockStreamText.mockClear();
    mockStepCountIs.mockClear();
    mockGetModel.mockClear();
    mockCreateTools.mockClear();
    mockLoadMCPServers.mockClear();
    mockLoadMCPTools.mockClear();

    // Reset to default return value
    mockStreamText.mockImplementation(async () => ({
      text: "hello from model",
      reasoningText: undefined as string | undefined,
      response: { messages: [{ role: "assistant", content: "hi" }] },
    }));
    mockStepCountIs.mockImplementation((_n: number) => "step-count-sentinel");
    mockGetModel.mockImplementation((_config: AgentConfig, _id?: string) => "model-sentinel");
    mockCreateTools.mockImplementation((_ctx: any) => ({
      bash: { type: "builtin" },
      read: { type: "builtin" },
    }));
    mockLoadMCPServers.mockImplementation(async (_config: AgentConfig) => [] as any[]);
    mockLoadMCPTools.mockImplementation(async (_servers: any[], _opts?: any) => ({
      tools: {} as Record<string, any>,
      errors: [] as string[],
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

  afterEach(() => {
    mock.restore();
  });

  // -------------------------------------------------------------------------
  // System prompt
  // -------------------------------------------------------------------------

  test("calls streamText with the correct system prompt", async () => {
    const params = makeParams({ system: "Custom system prompt" });
    await runTurn(params);

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.system).toBe("Custom system prompt");
  });

  test("removes MCP namespacing guidance when MCP tools are not active", async () => {
    const system =
      "Header\nMCP tool names are namespaced as `mcp__{serverName}__{toolName}` to prevent collisions.\nFooter";

    await runTurn(makeParams({ system, enableMcp: false }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.system).not.toContain("`mcp__{serverName}__{toolName}`");
    expect(callArg.system).toContain("Header");
    expect(callArg.system).toContain("Footer");
    expect(callArg.system).not.toContain("## Active MCP Tools");
  });

  test("adds MCP namespacing guidance only when MCP tools are active", async () => {
    mockLoadMCPServers.mockResolvedValue([{ name: "srv", transport: { type: "stdio", command: "x", args: [] } }]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__srv__doThing": { type: "mcp-tool" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true, system: "Base system prompt" }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.system).toContain("## Active MCP Tools");
    expect(callArg.system).toContain("`mcp__{serverName}__{toolName}`");
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  test("calls streamText with the correct messages", async () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ] as any[];
    const params = makeParams({ messages: msgs });
    await runTurn(params);

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.messages).toBe(msgs);
  });

  test("preserves google tool-call history without dropping parts", async () => {
    const log = mock(() => {});
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: { type: "json", value: {} } }],
      },
    ] as any[];

    await runTurn(makeParams({ messages: msgs, log }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.messages).toBe(msgs);
    const serialized = JSON.stringify(callArg.messages);
    expect(serialized).toContain("\"type\":\"tool-call\"");
    expect(serialized).toContain("\"type\":\"tool-result\"");
  });

  test("keeps google includeThoughts enabled and repairs replay signatures in prepareStep", async () => {
    const log = mock(() => {});
    const providerOptions = {
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    };
    await runTurn(makeParams({ config: makeConfig({ providerOptions }), log }));
    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.providerOptions.google.thinkingConfig.includeThoughts).toBe(true);
    expect(callArg.providerOptions.google.thinkingConfig.thinkingLevel).toBe("high");
    expect(typeof callArg.prepareStep).toBe("function");

    const replayMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: { google: { thoughtSignature: "sig-1" } },
          },
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[];

    const prepareResult = await callArg.prepareStep({ stepNumber: 1, messages: replayMessages });
    expect(prepareResult).toBeDefined();
    expect(prepareResult.providerOptions).toBeUndefined();
    const serialized = JSON.stringify(prepareResult.messages);
    expect(serialized).toContain("\"thoughtSignature\":\"sig-1\"");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Repaired 1 Gemini tool call"));
  });

  test("prepareStep falls back by disabling thoughts when signatures are unresolved", async () => {
    const log = mock(() => {});
    const providerOptions = {
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    };
    await runTurn(makeParams({ config: makeConfig({ providerOptions }), log }));
    const callArg = mockStreamText.mock.calls[0][0] as any;
    const replayMessages = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } }],
      },
    ] as any[];
    const prepareResult = await callArg.prepareStep({ stepNumber: 1, messages: replayMessages });
    expect(prepareResult).toBeDefined();
    expect(prepareResult.providerOptions.google.thinkingConfig.includeThoughts).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disabling thoughts for this step"));
  });

  test("keeps provider options unchanged for non-google providers", async () => {
    const providerOptions = { openai: { reasoningEffort: "high" } };
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } }],
      },
    ] as any[];

    await runTurn(makeParams({ config: makeConfig({ provider: "openai", providerOptions }), messages: msgs }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBe(providerOptions);
  });

  // -------------------------------------------------------------------------
  // Return text
  // -------------------------------------------------------------------------

  test("returns text from streamText result", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: "model output text",
      reasoningText: undefined,
      response: { messages: [] },
    }));

    const result = await runTurn(makeParams());
    expect(result.text).toBe("model output text");
  });

  test("returns empty string when text is null/undefined", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: undefined,
      reasoningText: undefined,
      response: { messages: [] },
    }));

    const result = await runTurn(makeParams());
    expect(result.text).toBe("");
  });

  // -------------------------------------------------------------------------
  // Reasoning text
  // -------------------------------------------------------------------------

  test("returns reasoningText when available", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: "answer",
      reasoningText: "Let me think...",
      response: { messages: [] },
    }));

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBe("Let me think...");
  });

  test("returns undefined when reasoningText is undefined", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: "answer",
      reasoningText: undefined,
      response: { messages: [] },
    }));

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBeUndefined();
  });

  test("returns undefined when reasoningText is not a string", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: "answer",
      reasoningText: 42,
      response: { messages: [] },
    }));

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Response messages
  // -------------------------------------------------------------------------

  test("returns responseMessages from result", async () => {
    const fakeMsgs = [
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ];
    mockStreamText.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      response: { messages: fakeMsgs },
    }));

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual(fakeMsgs);
  });

  test("returns empty array when responseMessages is undefined", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      response: {},
    }));

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual([]);
  });

  test("returns empty array when response is undefined", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      response: undefined,
    }));

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  test("keeps canonical usage counters when providers include extra usage keys", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      response: {
        messages: [],
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cachedPromptTokens: 20,
          reasoningTokens: 5,
        },
      },
    }));

    const result = await runTurn(makeParams());
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  // -------------------------------------------------------------------------
  // maxSteps
  // -------------------------------------------------------------------------

  test("passes default maxSteps of 100 to stepCountIs", async () => {
    await runTurn(makeParams());

    expect(mockStepCountIs).toHaveBeenCalledWith(100);
  });

  test("passes overridden maxSteps to stepCountIs", async () => {
    await runTurn(makeParams({ maxSteps: 25 }));

    expect(mockStepCountIs).toHaveBeenCalledWith(25);
  });

  test("stopWhen receives the result of stepCountIs", async () => {
    await runTurn(makeParams());

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.stopWhen).toBe("step-count-sentinel");
  });

  // -------------------------------------------------------------------------
  // Config -> getModel
  // -------------------------------------------------------------------------

  test("passes config to getModel", async () => {
    const config = makeConfig({ model: "test-model-42" });
    await runTurn(makeParams({ config }));

    expect(mockGetModel).toHaveBeenCalledTimes(1);
    expect(mockGetModel.mock.calls[0][0]).toBe(config);
  });

  test("uses getModel result as model in streamText", async () => {
    mockGetModel.mockReturnValue("special-model");
    await runTurn(makeParams());

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.model).toBe("special-model");
  });

  // -------------------------------------------------------------------------
  // providerOptions
  // -------------------------------------------------------------------------

  test("passes providerOptions from config to streamText", async () => {
    const providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 5000 } } };
    const config = makeConfig({ providerOptions });
    await runTurn(makeParams({ config }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBe(providerOptions);
  });

  test("providerOptions is undefined when config has none", async () => {
    const config = makeConfig();
    delete config.providerOptions;
    await runTurn(makeParams({ config }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBeUndefined();
  });

  test("enables AI SDK telemetry with full I/O when observability is configured", async () => {
    const config = makeConfig({
      observabilityEnabled: true,
      observability: {
        provider: "langfuse",
        baseUrl: "https://cloud.langfuse.com",
        otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
      },
    });

    await runTurn(makeParams({
      config,
      telemetryContext: {
        functionId: "session.turn",
        metadata: { sessionId: "session-123" },
      },
    }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.experimental_telemetry).toBeDefined();
    expect(callArg.experimental_telemetry.isEnabled).toBe(true);
    expect(callArg.experimental_telemetry.recordInputs).toBe(true);
    expect(callArg.experimental_telemetry.recordOutputs).toBe(true);
    expect(callArg.experimental_telemetry.functionId).toBe("session.turn");
    expect(callArg.experimental_telemetry.metadata.sessionId).toBe("session-123");
  });

  // -------------------------------------------------------------------------
  // Model stream passthrough
  // -------------------------------------------------------------------------

  test("passes includeRawChunks=true by default to streamText", async () => {
    await runTurn(makeParams());

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.includeRawChunks).toBe(true);
  });

  test("passes includeRawChunks override to streamText", async () => {
    await runTurn(makeParams({ includeRawChunks: false }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.includeRawChunks).toBe(false);
  });

  test("forwards ordered fullStream parts to onModelStreamPart callback", async () => {
    const parts = [
      { type: "start" },
      { type: "text-delta", id: "t1", text: "hello" },
      { type: "finish", finishReason: "stop" },
    ];

    mockStreamText.mockImplementation(async () => ({
      text: "hello",
      reasoningText: undefined,
      response: { messages: [] },
      fullStream: (async function* () {
        for (const part of parts) yield part;
      })(),
    }));

    const seen: unknown[] = [];
    await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      })
    );

    expect(seen).toEqual(parts);
  });

  test("does not hang when fullStream never closes after provider-native tool usage", async () => {
    mockStreamText.mockImplementation(async () => ({
      text: "completed response",
      reasoningText: undefined,
      response: { messages: [{ role: "assistant", content: "done" }] },
      fullStream: (async function* () {
        yield { type: "start" };
        await new Promise(() => {});
      })(),
    }));

    const log = mock(() => {});
    const seen: unknown[] = [];
    const result = await Promise.race([
      runTurn(
        makeParams({
          log,
          onModelStreamPart: async (part) => {
            seen.push(part);
          },
        })
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ]);

    expect(result).not.toBe("timeout");
    if (result === "timeout") return;
    expect(result.text).toBe("completed response");
    expect(seen).toEqual([{ type: "start" }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Model stream did not drain"));
  });

  // -------------------------------------------------------------------------
  // createTools
  // -------------------------------------------------------------------------

  test("creates tools via createTools with correct context", async () => {
    const config = makeConfig();
    const log = mock(() => {});
    const askUser = mock(async () => "ok");
    const approveCommand = mock(async () => true);
    const updateTodos = mock(() => {});

    await runTurn(makeParams({ config, log, askUser, approveCommand, updateTodos }));

    expect(mockCreateTools).toHaveBeenCalledTimes(1);
    const ctx = mockCreateTools.mock.calls[0][0] as any;
    expect(ctx.config).toBe(config);
    expect(ctx.log).toBe(log);
    expect(ctx.askUser).toBe(askUser);
    expect(ctx.approveCommand).toBe(approveCommand);
    expect(ctx.updateTodos).toBe(updateTodos);
  });

  test("passes abortSignal through tool context", async () => {
    const abortController = new AbortController();
    await runTurn(makeParams({ abortSignal: abortController.signal }));

    const ctx = mockCreateTools.mock.calls[0][0] as any;
    expect(ctx.abortSignal).toBe(abortController.signal);
  });

  test("passes best-effort latest user prompt through tool context", async () => {
    await runTurn(
      makeParams({
        messages: [
          { role: "assistant", content: "hello" },
          { role: "user", content: "find the latest filing" },
        ] as any,
      })
    );

    const ctx = mockCreateTools.mock.calls[0][0] as any;
    expect(ctx.turnUserPrompt).toBe("find the latest filing");
  });

  test("builtin tools are included in tools passed to streamText", async () => {
    mockCreateTools.mockReturnValue({ myTool: { type: "custom" } });
    await runTurn(makeParams());

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.tools).toHaveProperty("myTool");
  });

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------

  test("does not load MCP servers when enableMcp is false", async () => {
    await runTurn(makeParams({ enableMcp: false }));

    expect(mockLoadMCPServers).not.toHaveBeenCalled();
    expect(mockLoadMCPTools).not.toHaveBeenCalled();
  });

  test("does not load MCP servers when enableMcp is undefined", async () => {
    const params = makeParams();
    delete params.enableMcp;
    await runTurn(params);

    expect(mockLoadMCPServers).not.toHaveBeenCalled();
  });

  test("loads MCP servers and tools when enableMcp is true", async () => {
    const mcpServers = [{ name: "test-server", transport: { type: "stdio", command: "echo", args: [] } }];
    mockLoadMCPServers.mockResolvedValue(mcpServers);
    mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__test-server__foo": { type: "mcp" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true }));

    expect(mockLoadMCPServers).toHaveBeenCalledTimes(1);
    expect(mockLoadMCPTools).toHaveBeenCalledTimes(1);
    expect(mockLoadMCPTools.mock.calls[0][0]).toBe(mcpServers);
  });

  test("MCP tools are merged into tools passed to streamText", async () => {
    mockCreateTools.mockReturnValue({ bash: { type: "builtin" } });
    mockLoadMCPServers.mockResolvedValue([{ name: "s", transport: { type: "stdio", command: "x", args: [] } }]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__s__doThing": { type: "mcp-tool" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.tools).toHaveProperty("bash");
    expect(callArg.tools).toHaveProperty("mcp__s__doThing");
  });

  test("MCP tool name collisions are remapped to a safe alias", async () => {
    const log = mock(() => {});
    mockCreateTools.mockReturnValue({ bash: { type: "builtin-bash" } });
    mockLoadMCPServers.mockResolvedValue([{ name: "s", transport: { type: "stdio", command: "x", args: [] } }]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { bash: { type: "mcp-bash" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true, log }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.tools.bash.type).toBe("builtin-bash");
    expect(callArg.tools).toHaveProperty("mcp__bash");
    expect(callArg.tools["mcp__bash"].type).toBe("mcp-bash");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("MCP tool name collision"));
  });

  test("forwards modelSettings maxRetries to streamText", async () => {
    const config = makeConfig({
      modelSettings: {
        maxRetries: 1,
      },
    });

    await runTurn(makeParams({ config }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(callArg.maxRetries).toBe(1);
  });

  test("stream onError callback forwards to onModelError", async () => {
    const onModelError = mock(async () => {});
    await runTurn(makeParams({ onModelError }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(typeof callArg.onError).toBe("function");
    await callArg.onError({ error: new Error("stream failed") });
    expect(onModelError).toHaveBeenCalledTimes(1);
  });

  test("stream onAbort callback forwards to onModelAbort", async () => {
    const onModelAbort = mock(async () => {});
    await runTurn(makeParams({ onModelAbort }));

    const callArg = mockStreamText.mock.calls[0][0] as any;
    expect(typeof callArg.onAbort).toBe("function");
    await callArg.onAbort({ steps: [] });
    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });

  test("does not call loadMCPTools when no servers are configured", async () => {
    mockLoadMCPServers.mockResolvedValue([]);

    await runTurn(makeParams({ enableMcp: true }));

    expect(mockLoadMCPServers).toHaveBeenCalled();
    expect(mockLoadMCPTools).not.toHaveBeenCalled();
  });

  test("passes log function to loadMCPTools opts", async () => {
    const logFn = mock(() => {});
    mockLoadMCPServers.mockResolvedValue([{ name: "a", transport: { type: "stdio", command: "x", args: [] } }]);
    mockLoadMCPTools.mockResolvedValue({ tools: {}, errors: [] });

    await runTurn(makeParams({ enableMcp: true, log: logFn }));

    const opts = mockLoadMCPTools.mock.calls[0][1] as any;
    expect(opts.log).toBe(logFn);
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  test("propagates errors from streamText", async () => {
    mockStreamText.mockRejectedValue(new Error("API rate limit exceeded"));

    await expect(runTurn(makeParams())).rejects.toThrow("API rate limit exceeded");
  });

  test("propagates errors from loadMCPServers", async () => {
    mockLoadMCPServers.mockRejectedValue(new Error("MCP server config error"));

    await expect(runTurn(makeParams({ enableMcp: true }))).rejects.toThrow("MCP server config error");
  });

  test("propagates errors from loadMCPTools", async () => {
    mockLoadMCPServers.mockResolvedValue([{ name: "x", transport: { type: "stdio", command: "y", args: [] } }]);
    mockLoadMCPTools.mockRejectedValue(new Error("Required MCP server failed"));

    await expect(runTurn(makeParams({ enableMcp: true }))).rejects.toThrow("Required MCP server failed");
  });

  test("propagates errors from createTools", async () => {
    mockCreateTools.mockImplementation(() => {
      throw new Error("Tool init failure");
    });

    await expect(runTurn(makeParams())).rejects.toThrow("Tool init failure");

    // restore default
    mockCreateTools.mockReturnValue({ bash: { type: "builtin" } });
  });
});
