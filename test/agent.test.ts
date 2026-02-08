import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";
import path from "node:path";

import * as REAL_AI from "ai";
import * as REAL_CONFIG from "../src/config";
import * as REAL_MCP from "../src/mcp/index";

import type { AgentConfig } from "../src/types";
import { createTools as realCreateTools } from "../src/tools/index";

// Snapshot the real implementation so we can restore it after this file's
// module mocks run. `mock.module()` overrides persist across test files within
// a Bun worker.
const REAL_CREATE_TOOLS = realCreateTools;

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

const mockGenerateText = mock(async () => ({
  text: "hello from model",
  reasoningText: undefined as string | undefined,
  response: { messages: [{ role: "assistant", content: "hi" }] },
}));

const mockStepCountIs = mock((_n: number) => "step-count-sentinel");

mock.module("ai", () => ({
  generateText: mockGenerateText,
  stepCountIs: mockStepCountIs,
}));

const mockGetModel = mock((_config: AgentConfig, _id?: string) => "model-sentinel");

mock.module("../src/config", () => ({
  getModel: mockGetModel,
}));

const mockCreateTools = mock((_ctx: any) => ({
  bash: { type: "builtin" },
  read: { type: "builtin" },
}));

mock.module("../src/tools", () => ({
  createTools: mockCreateTools,
}));

const mockLoadMCPServers = mock(async (_config: AgentConfig) => [] as any[]);
const mockLoadMCPTools = mock(async (_servers: any[], _opts?: any) => ({
  tools: {} as Record<string, any>,
  errors: [] as string[],
}));

mock.module("../src/mcp", () => ({
  loadMCPServers: mockLoadMCPServers,
  loadMCPTools: mockLoadMCPTools,
}));

// Now import the module under test -- after the mocks are registered.
import { runTurn, type RunTurnParams } from "../src/agent";

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
  afterAll(() => {
    // Prevent this file's module mock from leaking into other test files.
    mock.module("ai", () => REAL_AI);
    mock.module("../src/config", () => REAL_CONFIG);
    mock.module("../src/mcp", () => REAL_MCP);
    mock.module("../src/tools", () => ({ createTools: REAL_CREATE_TOOLS }));
    mock.module("../src/tools/index", () => ({ createTools: REAL_CREATE_TOOLS }));
  });

  beforeEach(() => {
    mockGenerateText.mockClear();
    mockStepCountIs.mockClear();
    mockGetModel.mockClear();
    mockCreateTools.mockClear();
    mockLoadMCPServers.mockClear();
    mockLoadMCPTools.mockClear();

    // Reset to default return value
    mockGenerateText.mockImplementation(async () => ({
      text: "hello from model",
      reasoningText: undefined as string | undefined,
      response: { messages: [{ role: "assistant", content: "hi" }] },
    }));
  });

  // -------------------------------------------------------------------------
  // System prompt
  // -------------------------------------------------------------------------

  test("calls generateText with the correct system prompt", async () => {
    const params = makeParams({ system: "Custom system prompt" });
    await runTurn(params);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const callArg = mockGenerateText.mock.calls[0][0] as any;
    expect(callArg.system).toBe("Custom system prompt");
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  test("calls generateText with the correct messages", async () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ] as any[];
    const params = makeParams({ messages: msgs });
    await runTurn(params);

    const callArg = mockGenerateText.mock.calls[0][0] as any;
    expect(callArg.messages).toBe(msgs);
  });

  // -------------------------------------------------------------------------
  // Return text
  // -------------------------------------------------------------------------

  test("returns text from generateText result", async () => {
    mockGenerateText.mockImplementation(async () => ({
      text: "model output text",
      reasoningText: undefined,
      response: { messages: [] },
    }));

    const result = await runTurn(makeParams());
    expect(result.text).toBe("model output text");
  });

  test("returns empty string when text is null/undefined", async () => {
    mockGenerateText.mockImplementation(async () => ({
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
    mockGenerateText.mockImplementation(async () => ({
      text: "answer",
      reasoningText: "Let me think...",
      response: { messages: [] },
    }));

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBe("Let me think...");
  });

  test("returns undefined when reasoningText is undefined", async () => {
    mockGenerateText.mockImplementation(async () => ({
      text: "answer",
      reasoningText: undefined,
      response: { messages: [] },
    }));

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBeUndefined();
  });

  test("returns undefined when reasoningText is not a string", async () => {
    mockGenerateText.mockImplementation(async () => ({
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
    mockGenerateText.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      response: { messages: fakeMsgs },
    }));

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual(fakeMsgs);
  });

  test("returns empty array when responseMessages is undefined", async () => {
    mockGenerateText.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      response: {},
    }));

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual([]);
  });

  test("returns empty array when response is undefined", async () => {
    mockGenerateText.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      response: undefined,
    }));

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual([]);
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

    const callArg = mockGenerateText.mock.calls[0][0] as any;
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

  test("uses getModel result as model in generateText", async () => {
    mockGetModel.mockReturnValue("special-model");
    await runTurn(makeParams());

    const callArg = mockGenerateText.mock.calls[0][0] as any;
    expect(callArg.model).toBe("special-model");
  });

  // -------------------------------------------------------------------------
  // providerOptions
  // -------------------------------------------------------------------------

  test("passes providerOptions from config to generateText", async () => {
    const providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 5000 } } };
    const config = makeConfig({ providerOptions });
    await runTurn(makeParams({ config }));

    const callArg = mockGenerateText.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBe(providerOptions);
  });

  test("providerOptions is undefined when config has none", async () => {
    const config = makeConfig();
    delete config.providerOptions;
    await runTurn(makeParams({ config }));

    const callArg = mockGenerateText.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBeUndefined();
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

  test("builtin tools are included in tools passed to generateText", async () => {
    mockCreateTools.mockReturnValue({ myTool: { type: "custom" } });
    await runTurn(makeParams());

    const callArg = mockGenerateText.mock.calls[0][0] as any;
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

  test("MCP tools are merged into tools passed to generateText", async () => {
    mockCreateTools.mockReturnValue({ bash: { type: "builtin" } });
    mockLoadMCPServers.mockResolvedValue([{ name: "s", transport: { type: "stdio", command: "x", args: [] } }]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__s__doThing": { type: "mcp-tool" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true }));

    const callArg = mockGenerateText.mock.calls[0][0] as any;
    expect(callArg.tools).toHaveProperty("bash");
    expect(callArg.tools).toHaveProperty("mcp__s__doThing");
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

  test("propagates errors from generateText", async () => {
    mockGenerateText.mockRejectedValue(new Error("API rate limit exceeded"));

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
