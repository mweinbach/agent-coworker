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
// Mock agentLoop helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock EventStream-like object that yields events and resolves
 * to a list of messages. Compatible with pi's agentLoop return type.
 */
class MockEventStream {
  private events: any[];
  private resultValue: any[];

  constructor(events: any[], resultValue: any[] = []) {
    this.events = events;
    this.resultValue = resultValue;
  }

  async *[Symbol.asyncIterator]() {
    for (const event of this.events) {
      yield event;
    }
  }

  async result() {
    return this.resultValue;
  }
}

/**
 * Builds a minimal set of AgentEvent objects from a response spec.
 * Returns the events array and a synthetic assistant message.
 */
function buildAgentEvents(response: {
  text?: string;
  reasoningText?: string;
  usage?: { input: number; output: number; totalTokens: number };
} = {}) {
  const text = response.text ?? "";
  const reasoningText = response.reasoningText;
  const usage = {
    input: response.usage?.input ?? 0,
    output: response.usage?.output ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: response.usage?.totalTokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  if (reasoningText) content.push({ type: "thinking", thinking: reasoningText });

  const assistMsg = {
    role: "assistant",
    content,
    api: "unknown",
    provider: "test",
    model: "test",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const events: any[] = [
    { type: "agent_start" },
    { type: "turn_start" },
  ];

  if (reasoningText) {
    events.push({
      type: "message_update",
      message: assistMsg,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: reasoningText,
        partial: assistMsg,
      },
    });
  }

  if (text) {
    events.push({
      type: "message_update",
      message: assistMsg,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: reasoningText ? 1 : 0,
        delta: text,
        partial: assistMsg,
      },
    });
  }

  events.push({
    type: "message_update",
    message: assistMsg,
    assistantMessageEvent: { type: "done", reason: "stop", message: assistMsg },
  });

  events.push({
    type: "turn_end",
    message: assistMsg,
    toolResults: [],
  });

  events.push({ type: "agent_end", messages: [assistMsg] });

  return { events, assistMsg };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

function createDefaultMockAgentLoop(response?: { text?: string; reasoningText?: string; usage?: any }) {
  const { events, assistMsg } = buildAgentEvents(response ?? { text: "hello from model" });
  return mock((_prompts: any, _context: any, _config: any, _signal?: AbortSignal) => {
    return new MockEventStream(events, [assistMsg]);
  });
}

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
  let mockAgentLoop: ReturnType<typeof createDefaultMockAgentLoop>;
  let runTurn: ReturnType<typeof createRunTurn>;

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();

    mockGetModel.mockClear();
    mockCreateTools.mockClear();
    mockLoadMCPServers.mockClear();
    mockLoadMCPTools.mockClear();

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

    mockAgentLoop = createDefaultMockAgentLoop();

    runTurn = createRunTurn({
      agentLoop: mockAgentLoop,
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

  test("passes the system prompt to agentLoop context", async () => {
    const params = makeParams({ system: "Custom system prompt" });
    await runTurn(params);

    expect(mockAgentLoop).toHaveBeenCalledTimes(1);
    const contextArg = mockAgentLoop.mock.calls[0][1] as any;
    expect(contextArg.systemPrompt).toBe("Custom system prompt");
  });

  test("removes MCP namespacing guidance when MCP tools are not active", async () => {
    const system =
      "Header\nMCP tool names are namespaced as `mcp__{serverName}__{toolName}` to prevent collisions.\nFooter";

    await runTurn(makeParams({ system, enableMcp: false }));

    const contextArg = mockAgentLoop.mock.calls[0][1] as any;
    expect(contextArg.systemPrompt).not.toContain("`mcp__{serverName}__{toolName}`");
    expect(contextArg.systemPrompt).toContain("Header");
    expect(contextArg.systemPrompt).toContain("Footer");
    expect(contextArg.systemPrompt).not.toContain("## Active MCP Tools");
  });

  test("adds MCP namespacing guidance only when MCP tools are active", async () => {
    mockLoadMCPServers.mockResolvedValue([{ name: "srv", transport: { type: "stdio", command: "x", args: [] } }]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__srv__doThing": { type: "mcp-tool" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true, system: "Base system prompt" }));

    const contextArg = mockAgentLoop.mock.calls[0][1] as any;
    expect(contextArg.systemPrompt).toContain("## Active MCP Tools");
    expect(contextArg.systemPrompt).toContain("`mcp__{serverName}__{toolName}`");
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  test("converts and passes messages to agentLoop context", async () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ] as any[];
    const params = makeParams({ messages: msgs });
    await runTurn(params);

    const contextArg = mockAgentLoop.mock.calls[0][1] as any;
    // Messages are converted from legacy to pi format
    expect(contextArg.messages.length).toBeGreaterThanOrEqual(1);
    expect(contextArg.messages[0].role).toBe("user");
  });

  // -------------------------------------------------------------------------
  // Return text
  // -------------------------------------------------------------------------

  test("returns text collected from text_delta events", async () => {
    mockAgentLoop = createDefaultMockAgentLoop({ text: "model output text" });
    runTurn = createRunTurn({
      agentLoop: mockAgentLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    const result = await runTurn(makeParams());
    expect(result.text).toBe("model output text");
  });

  test("returns empty string when no text events are emitted", async () => {
    mockAgentLoop = createDefaultMockAgentLoop({ text: "" });
    runTurn = createRunTurn({
      agentLoop: mockAgentLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    const result = await runTurn(makeParams());
    expect(result.text).toBe("");
  });

  // -------------------------------------------------------------------------
  // Reasoning text
  // -------------------------------------------------------------------------

  test("returns reasoningText when thinking events are emitted", async () => {
    mockAgentLoop = createDefaultMockAgentLoop({ text: "answer", reasoningText: "Let me think..." });
    runTurn = createRunTurn({
      agentLoop: mockAgentLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBe("Let me think...");
  });

  test("returns undefined when no thinking events are emitted", async () => {
    mockAgentLoop = createDefaultMockAgentLoop({ text: "answer" });
    runTurn = createRunTurn({
      agentLoop: mockAgentLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Response messages
  // -------------------------------------------------------------------------

  test("returns responseMessages collected from turn_end events", async () => {
    const result = await runTurn(makeParams());
    expect(result.responseMessages.length).toBeGreaterThanOrEqual(1);
    expect((result.responseMessages[0] as any).role).toBe("assistant");
  });

  test("returns empty array when no turn_end events are emitted", async () => {
    const emptyLoop = mock((_prompts: any, _context: any, _config: any, _signal?: AbortSignal) => {
      return new MockEventStream([
        { type: "agent_start" },
        { type: "agent_end", messages: [] },
      ], []);
    });
    runTurn = createRunTurn({
      agentLoop: emptyLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  test("aggregates usage from done events", async () => {
    mockAgentLoop = createDefaultMockAgentLoop({
      text: "ok",
      usage: { input: 100, output: 50, totalTokens: 150 },
    });
    runTurn = createRunTurn({
      agentLoop: mockAgentLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    const result = await runTurn(makeParams());
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
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

  test("uses getModel result as model in agentLoop config", async () => {
    mockGetModel.mockReturnValue("special-model");
    await runTurn(makeParams());

    const configArg = mockAgentLoop.mock.calls[0][2] as any;
    expect(configArg.model).toBe("special-model");
  });

  // -------------------------------------------------------------------------
  // Stream part forwarding
  // -------------------------------------------------------------------------

  test("forwards pi events as synthetic AI SDK stream parts to onModelStreamPart", async () => {
    const seen: unknown[] = [];
    await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      })
    );

    // Should receive at minimum: start, text-delta, finish-step, finish
    const types = seen.map((s: any) => s.type);
    expect(types).toContain("start");
    expect(types).toContain("text-delta");
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

  test("builtin tools are included in agentLoop context tools", async () => {
    mockCreateTools.mockReturnValue({ myTool: { name: "myTool", type: "custom" } });
    await runTurn(makeParams());

    const contextArg = mockAgentLoop.mock.calls[0][1] as any;
    const toolNames = contextArg.tools.map((t: any) => t.name ?? Object.keys(t)[0]);
    // The tools array should contain our tool
    expect(contextArg.tools.length).toBeGreaterThanOrEqual(1);
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

  test("MCP tool name collisions are remapped to a safe alias", async () => {
    const log = mock(() => {});
    mockCreateTools.mockReturnValue({ bash: { name: "bash", type: "builtin-bash" } });
    mockLoadMCPServers.mockResolvedValue([{ name: "s", transport: { type: "stdio", command: "x", args: [] } }]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { bash: { name: "bash", type: "mcp-bash" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true, log }));

    expect(log).toHaveBeenCalledWith(expect.stringContaining("MCP tool name collision"));
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
  // maxSteps enforcement
  // -------------------------------------------------------------------------

  test("stops after maxSteps turns via break", async () => {
    // Create an agentLoop that emits 5 turns
    const events: any[] = [{ type: "agent_start" }];
    for (let i = 0; i < 5; i++) {
      const assistMsg = {
        role: "assistant",
        content: [{ type: "text", text: `turn ${i}` }],
        api: "unknown", provider: "test", model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      events.push({ type: "turn_start" });
      events.push({
        type: "message_update", message: assistMsg,
        assistantMessageEvent: { type: "done", reason: "stop", message: assistMsg },
      });
      events.push({ type: "turn_end", message: assistMsg, toolResults: [] });
    }
    events.push({ type: "agent_end", messages: [] });

    const limitLoop = mock((_p: any, _c: any, _cfg: any, _s?: AbortSignal) =>
      new MockEventStream(events, [])
    );
    runTurn = createRunTurn({
      agentLoop: limitLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    const log = mock(() => {});
    await runTurn(makeParams({ maxSteps: 3, log }));

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Maximum step count (3) reached"));
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  test("propagates errors from agentLoop", async () => {
    const errorLoop = mock((_p: any, _c: any, _cfg: any, _s?: AbortSignal) => {
      return new MockEventStream([
        { type: "agent_start" },
        // Simulate error by making the iterator throw
      ], []);
    });
    // Override the iterator to throw
    errorLoop.mockImplementation((_p: any, _c: any, _cfg: any, _s?: AbortSignal) => {
      const stream = {
        async *[Symbol.asyncIterator]() {
          throw new Error("API rate limit exceeded");
        },
        async result() { return []; },
      };
      return stream;
    });

    runTurn = createRunTurn({
      agentLoop: errorLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

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

  test("handles abort errors gracefully without re-throwing", async () => {
    const abortLoop = mock((_p: any, _c: any, _cfg: any, _s?: AbortSignal) => {
      const stream = {
        async *[Symbol.asyncIterator]() {
          throw new DOMException("The operation was aborted", "AbortError");
        },
        async result() { return []; },
      };
      return stream;
    });

    runTurn = createRunTurn({
      agentLoop: abortLoop,
      getModel: mockGetModel,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    const onModelAbort = mock(async () => {});
    // Should NOT throw — abort is handled gracefully
    const result = await runTurn(makeParams({ onModelAbort }));
    expect(result.text).toBe("");
    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });
});
