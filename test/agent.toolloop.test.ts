import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { createRunTurn, type RunTurnParams } from "../src/agent";
import type { loadMCPServers, loadMCPTools } from "../src/mcp";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";
import type { PiStreamFunction } from "../src/runtime/pi/types";
import { createPiRuntime } from "../src/runtime/piRuntime";
import type { RuntimeToolMap } from "../src/runtime/types";
import type { ToolContext } from "../src/tools/context";
import type { AgentConfig } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = "/tmp/agent-test";
  return {
    provider: "anthropic",
    model: "claude-opus-4-7",
    preferredChildModel: "claude-opus-4-7",
    modelSettings: { maxRetries: 0 },
    workingDirectory: base,
    outputDirectory: path.join(base, "output"),
    uploadsDirectory: path.join(base, "uploads"),
    userName: "tester",
    knowledgeCutoff: "2025-01",
    projectCoworkDir: path.join(base, ".cowork"),
    userCoworkDir: path.join(base, ".agent-user"),
    builtInDir: base,
    builtInConfigDir: path.join(base, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    observabilityEnabled: false,
    ...overrides,
  };
}

function makeParams(overrides: Partial<RunTurnParams> = {}): RunTurnParams {
  return {
    config: makeConfig(),
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    log: mock(() => {}),
    askUser: mock(async () => "yes"),
    approveCommand: mock(async () => true),
    toolEnv: { COWORK_DISABLE_RUNTIME: "1" },
    ...overrides,
  };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-7",
    content,
    usage: {
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

// Only the provider stream is scripted; PI owns event mapping, tool execution and history.
function providerStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  for (const [contentIndex, part] of message.content.entries()) {
    if (part.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({ type: "text_delta", contentIndex, delta: part.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: part.text, partial: message });
    } else if (part.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: JSON.stringify(part.arguments),
        partial: message,
      });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
    }
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  return stream;
}

const bashCall: ToolCall = {
  type: "toolCall",
  id: "tc-1",
  name: "bash",
  arguments: { command: "ls" },
};

function makeMockDeps() {
  const mockPiStream = mock<PiStreamFunction>(() =>
    providerStream(assistant([{ type: "text", text: "hello" }])),
  );
  const mockExecuteBash = mock(async (_input: unknown) => "file.txt");
  const mockExecuteRead = mock(async (_input: unknown) => "contents");
  const mockCreateTools = mock(
    (_ctx: ToolContext): RuntimeToolMap => ({
      bash: { inputSchema: z.object({ command: z.string() }), execute: mockExecuteBash },
      read: { inputSchema: z.object({ path: z.string() }), execute: mockExecuteRead },
    }),
  );
  const mockLoadMCPServers = mock<typeof loadMCPServers>(async () => []);
  const mockLoadMCPTools = mock<typeof loadMCPTools>(async () => ({ tools: {}, errors: [] }));
  return {
    mockPiStream,
    mockExecuteBash,
    mockExecuteRead,
    mockCreateTools,
    mockLoadMCPServers,
    mockLoadMCPTools,
  };
}

describe("runTurn – multi-step tool loops", () => {
  let deps: ReturnType<typeof makeMockDeps>;
  let runTurn: ReturnType<typeof createRunTurn>;

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();
    deps = makeMockDeps();
    runTurn = createRunTurn({
      createRuntime: () => createPiRuntime({ piStreamImpl: deps.mockPiStream }),
      createTools: deps.mockCreateTools,
      loadMCPServers: deps.mockLoadMCPServers,
      loadMCPTools: deps.mockLoadMCPTools,
    });
  });

  afterEach(() => {
    mock.restore();
  });

  function toolThenText() {
    deps.mockPiStream
      .mockImplementationOnce(() => providerStream(assistant([bashCall], "toolUse")))
      .mockImplementationOnce(() =>
        providerStream(assistant([{ type: "text", text: "I found file.txt." }])),
      );
  }

  test("executes a tool between provider calls and forwards stream parts in order", async () => {
    toolThenText();
    const seen: Array<Record<string, unknown>> = [];
    const result = await runTurn(
      makeParams({
        onModelStreamPart: (part) => {
          seen.push(part as Record<string, unknown>);
        },
      }),
    );

    expect(seen.map((part) => part.type)).toEqual([
      "start-step",
      "start",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
      "finish-step",
      "tool-result",
      "start-step",
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
      "finish-step",
    ]);
    expect(deps.mockExecuteBash).toHaveBeenCalledWith(
      { command: "ls" },
      { abortSignal: undefined },
    );
    expect(deps.mockPiStream).toHaveBeenCalledTimes(2);
    expect(deps.mockPiStream.mock.calls[1]?.[1].messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "tc-1",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
      }),
    );
    expect(result.text).toBe("I found file.txt.");
  });

  test("responseMessages accumulates actual tool call and result history", async () => {
    toolThenText();
    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "bash",
            output: { type: "text", value: "file.txt" },
            isError: false,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "I found file.txt." }] },
    ]);
    expect(result.usage).toMatchObject({ promptTokens: 20, completionTokens: 2, totalTokens: 22 });
  });

  test("passes the abort signal to the provider and reports an aborted turn once", async () => {
    const controller = new AbortController();
    const onModelAbort = mock(async () => {});
    const onModelError = mock(async () => {});
    deps.mockPiStream.mockImplementation((_model, _context, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      return providerStream(assistant([], "aborted", "Model turn aborted."));
    });
    await expect(
      runTurn(makeParams({ abortSignal: controller.signal, onModelAbort, onModelError })),
    ).rejects.toThrow("aborted");
    expect(onModelAbort).toHaveBeenCalledTimes(1);
    expect(onModelError).not.toHaveBeenCalled();
  });

  test("closes MCP connections when the provider rejects after tools are loaded", async () => {
    const close = mock(async () => {});
    deps.mockLoadMCPServers.mockResolvedValue([
      { name: "test-mcp", transport: { type: "stdio", command: "echo", args: [] } },
    ]);
    deps.mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__test-mcp__action": { execute: async () => "ok" } },
      errors: [],
      close,
    });
    deps.mockPiStream.mockImplementation(() => {
      throw new Error("Provider connection failed");
    });
    await expect(runTurn(makeParams({ enableMcp: true }))).rejects.toThrow(
      "Provider connection failed",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("maps tool input events and emits tool errors from actual failed executions", async () => {
    deps.mockExecuteRead.mockRejectedValue(new Error("not found"));
    deps.mockPiStream
      .mockImplementationOnce(() =>
        providerStream(
          assistant(
            [
              bashCall,
              { type: "toolCall", id: "tc-2", name: "read", arguments: { path: "missing.txt" } },
              { type: "toolCall", id: "tc-3", name: "missing", arguments: {} },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => providerStream(assistant([{ type: "text", text: "done" }])));
    const seen: Array<Record<string, unknown>> = [];
    const result = await runTurn(
      makeParams({
        onModelStreamPart: (part) => {
          seen.push(part as Record<string, unknown>);
        },
      }),
    );
    expect(seen).toContainEqual({ type: "tool-input-start", id: "tc-1", toolName: "bash" });
    expect(seen).toContainEqual({
      type: "tool-input-delta",
      id: "tc-1",
      delta: '{"command":"ls"}',
    });
    expect(seen).toContainEqual({ type: "tool-input-end", id: "tc-1" });
    expect(seen).toContainEqual({
      type: "tool-call",
      toolCallId: "tc-1",
      toolName: "bash",
      input: { command: "ls" },
    });
    expect(seen).toContainEqual({
      type: "tool-result",
      toolCallId: "tc-1",
      toolName: "bash",
      output: "file.txt",
    });
    expect(seen.filter((part) => part.type === "tool-error")).toEqual([
      { type: "tool-error", toolCallId: "tc-2", toolName: "read", error: "not found" },
      {
        type: "tool-error",
        toolCallId: "tc-3",
        toolName: "missing",
        error: "Tool missing not found",
      },
    ]);
    expect(result.responseMessages.filter((message) => message.role === "tool")).toHaveLength(3);
    expect(result.text).toBe("done");
  });

  test("emits numbered step boundaries for actual model calls", async () => {
    toolThenText();
    const seen: Array<Record<string, unknown>> = [];
    await runTurn(
      makeParams({
        onModelStreamPart: (part) => {
          seen.push(part as Record<string, unknown>);
        },
      }),
    );
    expect(
      seen.filter((part) => part.type === "start-step").map((part) => part.stepNumber),
    ).toEqual([1, 2]);
    expect(
      seen
        .filter((part) => part.type === "finish-step")
        .map((part) => [part.stepNumber, part.finishReason]),
    ).toEqual([
      [1, "toolUse"],
      [2, "stop"],
    ]);
  });

  test("maxSteps stops the real loop after executing the first tool call", async () => {
    toolThenText();
    const result = await runTurn(makeParams({ maxSteps: 1 }));
    expect(deps.mockPiStream).toHaveBeenCalledTimes(1);
    expect(deps.mockExecuteBash).toHaveBeenCalledTimes(1);
    expect(result.responseMessages).toHaveLength(2);
    expect(result.text).toBe("");
  });

  test("a provider error after visible text fails instead of claiming partial success", async () => {
    deps.mockPiStream.mockImplementation(() =>
      providerStream(assistant([{ type: "text", text: "partial" }], "error", "Stream interrupted")),
    );
    const onModelError = mock(async () => {});
    const seen: Array<Record<string, unknown>> = [];
    await expect(
      runTurn(
        makeParams({
          onModelError,
          onModelStreamPart: (part) => {
            seen.push(part as Record<string, unknown>);
          },
        }),
      ),
    ).rejects.toThrow("Stream interrupted");
    expect(seen).toContainEqual({ type: "text-delta", id: "s0", text: "partial" });
    expect(seen.some((part) => part.type === "finish-step")).toBe(false);
    expect(onModelError).toHaveBeenCalledTimes(1);
    expect(deps.mockPiStream).toHaveBeenCalledTimes(1);
  });

  test("waits for asynchronous stream callbacks before completing the turn", async () => {
    const callbackStarted = Promise.withResolvers<void>();
    const releaseCallback = Promise.withResolvers<void>();
    let finished = false;
    const turn = runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          if ((part as { type: string }).type === "text-delta") {
            callbackStarted.resolve();
            await releaseCallback.promise;
          }
        },
      }),
    ).then((result) => {
      finished = true;
      return result;
    });
    await callbackStarted.promise;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    } finally {
      releaseCallback.resolve();
    }
    expect((await turn).text).toBe("hello");
    expect(finished).toBe(true);
  });

  describe("extractTurnUserPrompt edge cases via tool context", () => {
    test("array content with multiple text parts joins them with newline", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return {};
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
        }),
      );

      expect(capturedCtx.turnUserPrompt).toBe("first line\nsecond line");
    });

    test("content part with inputText field is used as fallback", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return {};
      });

      await runTurn(
        makeParams({
          messages: [
            {
              role: "user",
              content: [{ type: "custom", inputText: "fallback input text" }],
            },
          ] as any[],
        }),
      );

      expect(capturedCtx.turnUserPrompt).toBe("fallback input text");
    });

    test("empty user message is skipped for previous non-empty message", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return {};
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
        }),
      );

      // The last user message has only whitespace, so extractTurnUserPrompt
      // should skip it and find the previous non-empty user message.
      expect(capturedCtx.turnUserPrompt).toBe("real prompt");
    });

    test("string content user message is extracted directly", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return {};
      });

      await runTurn(
        makeParams({
          messages: [
            {
              role: "user",
              content: "plain string prompt",
            },
          ] as any[],
        }),
      );

      expect(capturedCtx.turnUserPrompt).toBe("plain string prompt");
    });

    test("returns undefined when all user messages are empty", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return {};
      });

      await runTurn(
        makeParams({
          messages: [
            { role: "user", content: "   " },
            { role: "user", content: [{ type: "text", text: "" }] },
          ] as any[],
        }),
      );

      expect(capturedCtx.turnUserPrompt).toBeUndefined();
    });

    test("mixed text and inputText parts are joined", async () => {
      let capturedCtx: any;
      deps.mockCreateTools.mockImplementation((ctx: any) => {
        capturedCtx = ctx;
        return {};
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
        }),
      );

      expect(capturedCtx.turnUserPrompt).toBe("from text field\nfrom inputText field");
    });
  });
});
