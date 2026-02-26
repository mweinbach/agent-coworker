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
// Mock EventStream
// ---------------------------------------------------------------------------

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

function makeAssistantMessage(text: string, usage?: any) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "unknown",
    provider: "test",
    model: "test",
    usage: usage ?? {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeToolResultMessage(toolCallId: string, toolName: string, content: string) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

function makeMockDeps() {
  const defaultAssistMsg = makeAssistantMessage("hello");
  const defaultEvents = [
    { type: "agent_start" },
    { type: "turn_start" },
    {
      type: "message_update",
      message: defaultAssistMsg,
      assistantMessageEvent: { type: "done", reason: "stop", message: defaultAssistMsg },
    },
    { type: "turn_end", message: defaultAssistMsg, toolResults: [] },
    { type: "agent_end", messages: [defaultAssistMsg] },
  ];

  const mockAgentLoop = mock((_prompts: any, _context: any, _config: any, _signal?: AbortSignal) => {
    return new MockEventStream(defaultEvents, [defaultAssistMsg]);
  });

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

  return {
    mockAgentLoop,
    mockGetModel,
    mockCreateTools,
    mockLoadMCPServers,
    mockLoadMCPTools,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTurn – multi-step tool loops (pi agentLoop)", () => {
  let deps: ReturnType<typeof makeMockDeps>;
  let runTurn: ReturnType<typeof createRunTurn>;

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();
    deps = makeMockDeps();
    runTurn = createRunTurn({
      agentLoop: deps.mockAgentLoop,
      getModel: deps.mockGetModel,
      createTools: deps.mockCreateTools,
      loadMCPServers: deps.mockLoadMCPServers,
      loadMCPTools: deps.mockLoadMCPTools,
    });
  });

  afterEach(() => {
    mock.restore();
  });

  // -------------------------------------------------------------------------
  // 1. Multi-step tool loop: text/tool events forwarded as synthetic parts
  // -------------------------------------------------------------------------

  test("multi-step tool loop forwards synthetic stream parts in order", async () => {
    const toolCallMsg = makeAssistantMessage("");
    (toolCallMsg as any).content = [
      { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
    ];

    const toolResult = makeToolResultMessage("tc-1", "bash", "file.txt");
    const finalMsg = makeAssistantMessage("Here are the files.");

    const events: any[] = [
      { type: "agent_start" },
      // Turn 1: tool call
      { type: "turn_start" },
      {
        type: "message_update", message: toolCallMsg,
        assistantMessageEvent: {
          type: "toolcall_end", contentIndex: 0,
          toolCall: { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
          partial: toolCallMsg,
        },
      },
      {
        type: "message_update", message: toolCallMsg,
        assistantMessageEvent: { type: "done", reason: "toolUse", message: toolCallMsg },
      },
      { type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash", result: "file.txt", isError: false },
      { type: "turn_end", message: toolCallMsg, toolResults: [toolResult] },
      // Turn 2: final response
      { type: "turn_start" },
      {
        type: "message_update", message: finalMsg,
        assistantMessageEvent: {
          type: "text_delta", contentIndex: 0, delta: "Here are the files.",
          partial: finalMsg,
        },
      },
      {
        type: "message_update", message: finalMsg,
        assistantMessageEvent: { type: "done", reason: "stop", message: finalMsg },
      },
      { type: "turn_end", message: finalMsg, toolResults: [] },
      { type: "agent_end", messages: [toolCallMsg, toolResult, finalMsg] },
    ];

    deps.mockAgentLoop.mockImplementation((_p: any, _c: any, _cfg: any, _s?: AbortSignal) =>
      new MockEventStream(events, [toolCallMsg, toolResult, finalMsg])
    );

    const seen: unknown[] = [];
    const result = await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      })
    );

    expect(result.text).toBe("Here are the files.");

    // Check synthetic stream parts were emitted
    const types = seen.map((s: any) => s.type);
    expect(types).toContain("start"); // from agent_start
    expect(types).toContain("start-step"); // from turn_start
    expect(types).toContain("tool-call"); // from toolcall_end
    expect(types).toContain("tool-result"); // from tool_execution_end
    expect(types).toContain("text-delta"); // from text_delta
    expect(types).toContain("finish-step"); // from turn_end
  });

  // -------------------------------------------------------------------------
  // 2. Response messages accumulate tool history
  // -------------------------------------------------------------------------

  test("responseMessages includes all turn messages in order", async () => {
    const toolCallMsg = makeAssistantMessage("");
    (toolCallMsg as any).content = [
      { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
    ];

    const toolResult = makeToolResultMessage("tc-1", "bash", "file.txt");
    const finalMsg = makeAssistantMessage("I found file.txt.");

    const events: any[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      {
        type: "message_update", message: toolCallMsg,
        assistantMessageEvent: { type: "done", reason: "toolUse", message: toolCallMsg },
      },
      { type: "turn_end", message: toolCallMsg, toolResults: [toolResult] },
      { type: "turn_start" },
      {
        type: "message_update", message: finalMsg,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "I found file.txt.", partial: finalMsg },
      },
      {
        type: "message_update", message: finalMsg,
        assistantMessageEvent: { type: "done", reason: "stop", message: finalMsg },
      },
      { type: "turn_end", message: finalMsg, toolResults: [] },
      { type: "agent_end", messages: [] },
    ];

    deps.mockAgentLoop.mockImplementation((_p: any, _c: any, _cfg: any, _s?: AbortSignal) =>
      new MockEventStream(events, [])
    );

    const result = await runTurn(makeParams());

    expect(result.responseMessages.length).toBe(3); // toolCallMsg, toolResult, finalMsg
    expect((result.responseMessages[0] as any).role).toBe("assistant");
    expect((result.responseMessages[1] as any).role).toBe("toolResult");
    expect((result.responseMessages[2] as any).role).toBe("assistant");
    expect(result.text).toBe("I found file.txt.");
  });

  // -------------------------------------------------------------------------
  // 3. Abort signal propagation
  // -------------------------------------------------------------------------

  test("abort signal is forwarded to agentLoop and abort is handled gracefully", async () => {
    const abortController = new AbortController();
    const onModelAbort = mock(async () => {});

    deps.mockAgentLoop.mockImplementation((_p: any, _c: any, _cfg: any, signal?: AbortSignal) => {
      // Verify signal was passed
      expect(signal).toBe(abortController.signal);

      const stream = {
        async *[Symbol.asyncIterator]() {
          yield { type: "agent_start" };
          abortController.abort();
          throw new DOMException("Aborted", "AbortError");
        },
        async result() { return []; },
      };
      return stream;
    });

    const result = await Promise.race([
      runTurn(
        makeParams({
          abortSignal: abortController.signal,
          onModelAbort,
        })
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000)),
    ]);

    expect(result).not.toBe("timeout");
    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 4. MCP cleanup on agentLoop error
  // -------------------------------------------------------------------------

  test("closeMcp is called when agentLoop throws after MCP tools are loaded", async () => {
    const mockClose = mock(async () => {});

    deps.mockLoadMCPServers.mockResolvedValue([
      { name: "test-mcp", transport: { type: "stdio", command: "echo", args: [] } },
    ]);
    deps.mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__test-mcp__action": { type: "mcp" } },
      errors: [],
      close: mockClose,
    });

    deps.mockAgentLoop.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error("Provider connection failed");
      },
      async result() { return []; },
    }));

    await expect(
      runTurn(makeParams({ enableMcp: true }))
    ).rejects.toThrow("Provider connection failed");

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 5. Tool execution events mapped to stream parts
  // -------------------------------------------------------------------------

  test("tool_execution_end events are mapped to tool-result and tool-error parts", async () => {
    const msg = makeAssistantMessage("done");
    const events: any[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash", result: "ok", isError: false },
      { type: "tool_execution_end", toolCallId: "tc-2", toolName: "read", result: "not found", isError: true },
      {
        type: "message_update", message: msg,
        assistantMessageEvent: { type: "done", reason: "stop", message: msg },
      },
      { type: "turn_end", message: msg, toolResults: [] },
      { type: "agent_end", messages: [] },
    ];

    deps.mockAgentLoop.mockImplementation((_p: any, _c: any, _cfg: any, _s?: AbortSignal) =>
      new MockEventStream(events, [])
    );

    const seen: unknown[] = [];
    await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      })
    );

    const toolResults = seen.filter((s: any) => s.type === "tool-result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).toolCallId).toBe("tc-1");

    const toolErrors = seen.filter((s: any) => s.type === "tool-error");
    expect(toolErrors.length).toBe(1);
    expect((toolErrors[0] as any).toolCallId).toBe("tc-2");
  });

  // -------------------------------------------------------------------------
  // 6. extractTurnUserPrompt edge cases
  // -------------------------------------------------------------------------

  describe("extractTurnUserPrompt edge cases via tool context", () => {
    test("array content with multiple text parts joins them with newline", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return { bash: { type: "builtin" } };
      });

      await runTurn(
        makeParams({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "first line" },
                { type: "text", text: "second line" },
              ],
            },
          ] as any[],
        })
      );

      expect(capturedCtx.turnUserPrompt).toBe("first line\nsecond line");
    });

    test("content part with inputText field is used as fallback", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return { bash: { type: "builtin" } };
      });

      await runTurn(
        makeParams({
          messages: [
            {
              role: "user",
              content: [
                { type: "custom", inputText: "fallback input text" },
              ],
            },
          ] as any[],
        })
      );

      expect(capturedCtx.turnUserPrompt).toBe("fallback input text");
    });

    test("empty user message is skipped for previous non-empty message", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return { bash: { type: "builtin" } };
      });

      await runTurn(
        makeParams({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "real prompt" }],
            },
            {
              role: "assistant",
              content: "assistant reply",
            },
            {
              role: "user",
              content: [{ type: "text", text: "   " }],
            },
          ] as any[],
        })
      );

      expect(capturedCtx.turnUserPrompt).toBe("real prompt");
    });

    test("string content user message is extracted directly", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return { bash: { type: "builtin" } };
      });

      await runTurn(
        makeParams({
          messages: [
            {
              role: "user",
              content: "plain string prompt",
            },
          ] as any[],
        })
      );

      expect(capturedCtx.turnUserPrompt).toBe("plain string prompt");
    });

    test("returns undefined when all user messages are empty", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return { bash: { type: "builtin" } };
      });

      await runTurn(
        makeParams({
          messages: [
            { role: "user", content: "   " },
            { role: "user", content: [{ type: "text", text: "" }] },
          ] as any[],
        })
      );

      expect(capturedCtx.turnUserPrompt).toBeUndefined();
    });

    test("mixed text and inputText parts are joined", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return { bash: { type: "builtin" } };
      });

      await runTurn(
        makeParams({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "from text field" },
                { type: "other", inputText: "from inputText field" },
              ],
            },
          ] as any[],
        })
      );

      expect(capturedCtx.turnUserPrompt).toBe("from text field\nfrom inputText field");
    });
  });
});
