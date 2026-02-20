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

/**
 * Creates a mock streamText implementation backed by an async iterable of
 * stream parts. The text/reasoningText/response are returned as deferred
 * promises that only resolve once the fullStream generator has been fully
 * consumed. This mirrors the real SDK behavior where these promises settle
 * after (or around the same time as) the stream completes, and avoids the
 * race where `Promise.all` wins before the settle loop can drain the stream.
 */
function makeStreamTextWithFullStream(
  parts: unknown[],
  opts: {
    text?: string;
    reasoningText?: string | undefined;
    responseMessages?: any[];
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  } = {}
) {
  const {
    text = "",
    reasoningText = undefined,
    responseMessages = [],
    usage = undefined,
  } = opts;

  return async () => {
    let resolveText!: (v: string) => void;
    let resolveReasoningText!: (v: string | undefined) => void;
    let resolveResponse!: (v: any) => void;

    const textPromise = new Promise<string>((r) => { resolveText = r; });
    const reasoningTextPromise = new Promise<string | undefined>((r) => { resolveReasoningText = r; });
    const responsePromise = new Promise<any>((r) => { resolveResponse = r; });

    const fullStream = (async function* () {
      for (const part of parts) {
        yield part;
      }
      // Stream fully consumed -- resolve the companion promises so that
      // Promise.all in the agent can settle.
      await Promise.resolve();
      resolveText(text);
      resolveReasoningText(reasoningText);
      resolveResponse({
        messages: responseMessages,
        ...(usage ? { usage } : {}),
      });
    })();

    return {
      text: textPromise,
      reasoningText: reasoningTextPromise,
      response: responsePromise,
      fullStream,
    };
  };
}

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

function makeMockDeps() {
  const mockStreamText = mock(async () => ({
    text: "hello",
    reasoningText: undefined as string | undefined,
    response: { messages: [] as any[] },
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

  return {
    mockStreamText,
    mockStepCountIs,
    mockGetModel,
    mockCreateTools,
    mockLoadMCPServers,
    mockLoadMCPTools,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTurn – multi-step tool loops", () => {
  let deps: ReturnType<typeof makeMockDeps>;
  let runTurn: ReturnType<typeof createRunTurn>;

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();
    deps = makeMockDeps();
    runTurn = createRunTurn({
      streamText: deps.mockStreamText,
      stepCountIs: deps.mockStepCountIs,
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
  // 1. Multi-step tool loop: all parts forwarded in order
  // -------------------------------------------------------------------------

  test("multi-step tool loop forwards all stream parts to onModelStreamPart in order", async () => {
    const streamParts = [
      { type: "start" },
      { type: "start-step", stepNumber: 0 },
      { type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: { command: "ls" } },
      { type: "tool-result", toolCallId: "tc-1", toolName: "bash", output: "file.txt" },
      { type: "finish-step", stepNumber: 0, finishReason: "tool-calls" },
      { type: "start-step", stepNumber: 1 },
      { type: "text-delta", id: "t1", text: "Here are the files." },
      { type: "finish-step", stepNumber: 1, finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ];

    deps.mockStreamText.mockImplementation(
      makeStreamTextWithFullStream(streamParts, {
        text: "Here are the files.",
        responseMessages: [{ role: "assistant", content: "Here are the files." }],
      })
    );

    const seen: unknown[] = [];
    await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      })
    );

    expect(seen).toEqual(streamParts);
    expect(seen.length).toBe(9);
    // Verify ordering: start before start-step, tool-call before tool-result, etc.
    expect((seen[0] as any).type).toBe("start");
    expect((seen[1] as any).type).toBe("start-step");
    expect((seen[1] as any).stepNumber).toBe(0);
    expect((seen[2] as any).type).toBe("tool-call");
    expect((seen[3] as any).type).toBe("tool-result");
    expect((seen[4] as any).type).toBe("finish-step");
    expect((seen[5] as any).type).toBe("start-step");
    expect((seen[5] as any).stepNumber).toBe(1);
    expect((seen[6] as any).type).toBe("text-delta");
    expect((seen[7] as any).type).toBe("finish-step");
    expect((seen[8] as any).type).toBe("finish");
  });

  // -------------------------------------------------------------------------
  // 2. Multi-step tool loop: responseMessages accumulates tool history
  // -------------------------------------------------------------------------

  test("responseMessages accumulates tool call/result history from multi-step execution", async () => {
    const toolCallMsg = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: { command: "ls" } },
      ],
    };
    const toolResultMsg = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "tc-1", toolName: "bash", output: "file.txt" },
      ],
    };
    const finalAssistantMsg = {
      role: "assistant",
      content: [{ type: "text", text: "I found file.txt." }],
    };

    const allResponseMessages = [toolCallMsg, toolResultMsg, finalAssistantMsg];

    deps.mockStreamText.mockImplementation(
      makeStreamTextWithFullStream(
        [{ type: "start" }, { type: "finish", finishReason: "stop" }],
        {
          text: "I found file.txt.",
          responseMessages: allResponseMessages,
        }
      )
    );

    const result = await runTurn(makeParams());

    expect(result.responseMessages).toEqual(allResponseMessages);
    expect(result.responseMessages.length).toBe(3);
    expect(result.responseMessages[0]).toBe(toolCallMsg);
    expect(result.responseMessages[1]).toBe(toolResultMsg);
    expect(result.responseMessages[2]).toBe(finalAssistantMsg);
    expect(result.text).toBe("I found file.txt.");
  });

  // -------------------------------------------------------------------------
  // 3. Abort signal propagation
  // -------------------------------------------------------------------------

  test("abortSignal is passed to streamText and onModelAbort is called", async () => {
    const abortController = new AbortController();
    const onModelAbort = mock(async () => {});

    // streamText that records the abort signal and captures the onAbort callback
    let capturedAbortSignal: AbortSignal | undefined;
    let capturedOnAbort: (() => void) | undefined;

    deps.mockStreamText.mockImplementation(async (opts: any) => {
      capturedAbortSignal = opts.abortSignal;
      capturedOnAbort = opts.onAbort;

      return {
        text: "partial",
        reasoningText: undefined,
        response: { messages: [] },
        fullStream: (async function* () {
          yield { type: "start" };
          // Abort mid-stream
          abortController.abort();
          // Fire the onAbort callback like the SDK would
          if (capturedOnAbort) await capturedOnAbort();
          yield { type: "finish", finishReason: "abort" };
        })(),
      };
    });

    const result = await Promise.race([
      runTurn(
        makeParams({
          abortSignal: abortController.signal,
          onModelAbort,
          onModelStreamPart: async () => {},
        })
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000)),
    ]);

    expect(result).not.toBe("timeout");
    expect(capturedAbortSignal).toBe(abortController.signal);
    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 4. MCP cleanup on streamText error
  // -------------------------------------------------------------------------

  test("closeMcp is called when streamText rejects after MCP tools are loaded", async () => {
    const mockClose = mock(async () => {});

    deps.mockLoadMCPServers.mockResolvedValue([
      { name: "test-mcp", transport: { type: "stdio", command: "echo", args: [] } },
    ]);
    deps.mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__test-mcp__action": { type: "mcp" } },
      errors: [],
      close: mockClose,
    });

    deps.mockStreamText.mockRejectedValue(new Error("Provider connection failed"));

    await expect(
      runTurn(makeParams({ enableMcp: true }))
    ).rejects.toThrow("Provider connection failed");

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 5. Tool-related stream parts forwarded correctly
  // -------------------------------------------------------------------------

  test("tool-related stream parts are forwarded through onModelStreamPart", async () => {
    const toolParts = [
      { type: "tool-input-start", toolCallId: "tc-1", toolName: "bash" },
      { type: "tool-input-delta", toolCallId: "tc-1", delta: '{"command' },
      { type: "tool-input-end", toolCallId: "tc-1" },
      { type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: { command: "ls" } },
      { type: "tool-result", toolCallId: "tc-1", toolName: "bash", output: "ok" },
      { type: "tool-error", toolCallId: "tc-2", toolName: "read", error: "not found" },
      { type: "tool-output-denied", toolCallId: "tc-3", toolName: "bash", reason: "blocked" },
    ];

    deps.mockStreamText.mockImplementation(
      makeStreamTextWithFullStream(
        [{ type: "start" }, ...toolParts, { type: "finish", finishReason: "stop" }],
        { text: "done" }
      )
    );

    const seen: unknown[] = [];
    await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      })
    );

    // All tool-related parts should appear in the collected output
    for (const toolPart of toolParts) {
      const found = seen.find(
        (s: any) => s.type === toolPart.type && s.toolCallId === (toolPart as any).toolCallId
      );
      expect(found).toBeDefined();
    }

    // Verify specific parts are present
    const toolInputStarts = seen.filter((s: any) => s.type === "tool-input-start");
    expect(toolInputStarts.length).toBe(1);

    const toolInputDeltas = seen.filter((s: any) => s.type === "tool-input-delta");
    expect(toolInputDeltas.length).toBe(1);

    const toolInputEnds = seen.filter((s: any) => s.type === "tool-input-end");
    expect(toolInputEnds.length).toBe(1);

    const toolCalls = seen.filter((s: any) => s.type === "tool-call");
    expect(toolCalls.length).toBe(1);

    const toolResults = seen.filter((s: any) => s.type === "tool-result");
    expect(toolResults.length).toBe(1);

    const toolErrors = seen.filter((s: any) => s.type === "tool-error");
    expect(toolErrors.length).toBe(1);

    const toolOutputDenied = seen.filter((s: any) => s.type === "tool-output-denied");
    expect(toolOutputDenied.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. Step events forwarded
  // -------------------------------------------------------------------------

  test("start-step and finish-step events with stepNumber are forwarded", async () => {
    const parts = [
      { type: "start" },
      { type: "start-step", stepNumber: 0 },
      { type: "text-delta", id: "t1", text: "step zero" },
      { type: "finish-step", stepNumber: 0, finishReason: "tool-calls" },
      { type: "start-step", stepNumber: 1 },
      { type: "text-delta", id: "t2", text: "step one" },
      { type: "finish-step", stepNumber: 1, finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ];

    deps.mockStreamText.mockImplementation(
      makeStreamTextWithFullStream(parts, { text: "step zerostep one" })
    );

    const seen: unknown[] = [];
    await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      })
    );

    const startSteps = seen.filter((s: any) => s.type === "start-step");
    expect(startSteps.length).toBe(2);
    expect((startSteps[0] as any).stepNumber).toBe(0);
    expect((startSteps[1] as any).stepNumber).toBe(1);

    const finishSteps = seen.filter((s: any) => s.type === "finish-step");
    expect(finishSteps.length).toBe(2);
    expect((finishSteps[0] as any).stepNumber).toBe(0);
    expect((finishSteps[0] as any).finishReason).toBe("tool-calls");
    expect((finishSteps[1] as any).stepNumber).toBe(1);
    expect((finishSteps[1] as any).finishReason).toBe("stop");
  });

  // -------------------------------------------------------------------------
  // 7. Error during stream consumption
  // -------------------------------------------------------------------------

  test("error during fullStream consumption is logged and turn still completes", async () => {
    const partsBeforeError = [
      { type: "start" },
      { type: "start-step", stepNumber: 0 },
      { type: "text-delta", id: "t1", text: "partial" },
    ];

    deps.mockStreamText.mockImplementation(async () => {
      // Use deferred promises that resolve after stream throws.
      // The stream will throw, which settles streamConsumption. Then the
      // promises resolve so Promise.all completes. The settle loop sees
      // streamConsumptionSettled === true, awaits it, catches the error.
      let resolveText!: (v: string) => void;
      let resolveReasoningText!: (v: undefined) => void;
      let resolveResponse!: (v: any) => void;

      const textPromise = new Promise<string>((r) => { resolveText = r; });
      const reasoningTextPromise = new Promise<undefined>((r) => { resolveReasoningText = r; });
      const responsePromise = new Promise<any>((r) => { resolveResponse = r; });

      // Resolve the promises after a short delay so the stream error
      // settles first, then Promise.all can complete.
      setTimeout(() => {
        resolveText("partial response");
        resolveReasoningText(undefined);
        resolveResponse({ messages: [{ role: "assistant", content: "partial response" }] });
      }, 10);

      return {
        text: textPromise,
        reasoningText: reasoningTextPromise,
        response: responsePromise,
        fullStream: (async function* () {
          for (const part of partsBeforeError) {
            yield part;
          }
          throw new Error("Stream interrupted");
        })(),
      };
    });

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
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000)),
    ]);

    expect(result).not.toBe("timeout");
    if (result === "timeout") return;

    // Parts before the error should have been forwarded
    expect(seen.length).toBe(3);
    expect(seen).toEqual(partsBeforeError);

    // The turn should still complete with the text
    expect(result.text).toBe("partial response");

    // The error should be logged as a warning
    const logCalls = (log as any).mock.calls.map((c: any) => c[0]);
    const hasWarning = logCalls.some(
      (msg: string) =>
        msg.includes("[warn]") && msg.includes("Stream interrupted")
    );
    expect(hasWarning).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. Stream already settled before settle loop
  // -------------------------------------------------------------------------

  test("stream that settles before Promise.all resolves takes the settled branch", async () => {
    // Create a fullStream that completes synchronously/instantly relative to the promises,
    // so that streamConsumptionSettled === true before the settle loop starts.
    let streamDone = false;

    deps.mockStreamText.mockImplementation(async () => {
      // We use deferred promises for text/reasoningText/response so that
      // fullStream finishes first, then the promises resolve.
      let resolveText!: (v: string) => void;
      let resolveReasoningText!: (v: undefined) => void;
      let resolveResponse!: (v: any) => void;

      const textPromise = new Promise<string>((r) => { resolveText = r; });
      const reasoningTextPromise = new Promise<undefined>((r) => { resolveReasoningText = r; });
      const responsePromise = new Promise<any>((r) => { resolveResponse = r; });

      const fullStream = (async function* () {
        yield { type: "start" };
        yield { type: "text-delta", id: "t1", text: "fast" };
        yield { type: "finish", finishReason: "stop" };
        streamDone = true;
        // Now that stream is done, resolve the promises
        // Use microtask delay to ensure the stream consumption promise settles first
        await Promise.resolve();
        resolveText("fast");
        resolveReasoningText(undefined);
        resolveResponse({ messages: [{ role: "assistant", content: "fast" }] });
      })();

      return {
        text: textPromise,
        reasoningText: reasoningTextPromise,
        response: responsePromise,
        fullStream,
      };
    });

    const seen: unknown[] = [];
    const result = await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      })
    );

    expect(streamDone).toBe(true);
    expect(seen.length).toBe(3);
    expect((seen[0] as any).type).toBe("start");
    expect((seen[1] as any).type).toBe("text-delta");
    expect((seen[2] as any).type).toBe("finish");
    expect(result.text).toBe("fast");
  });

  // -------------------------------------------------------------------------
  // 9. extractTurnUserPrompt edge cases
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

      // The last user message has only whitespace, so extractTurnUserPrompt
      // should skip it and find the previous non-empty user message.
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
