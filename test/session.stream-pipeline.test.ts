import { describe, expect, test, mock, beforeEach } from "bun:test";
import path from "node:path";
import type { AgentConfig } from "../src/types";
import type { ServerEvent } from "../src/server/protocol";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";

const mockRunTurn = mock(async () => ({
  text: "",
  reasoningText: undefined as string | undefined,
  responseMessages: [] as any[],
}));

mock.module("../src/agent", () => ({
  runTurn: mockRunTurn,
}));

const mockGenerateSessionTitle = mock(async () => ({
  title: "Mock title",
  source: "heuristic" as const,
  model: null as string | null,
}));

const mockWritePersistedSessionSnapshot = mock(async () => "/tmp/mock.json");

const { AgentSession } = await import("../src/server/session");

function makeConfig(dir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-2.0-flash",
    subAgentModel: "gemini-2.0-flash",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

function makeEmit(): { emit: (evt: ServerEvent) => void; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  return { emit: (event: ServerEvent) => { events.push(event); }, events };
}

function makeSession(overrides?: { config?: AgentConfig; provider?: string }) {
  const dir = "/tmp/test-session";
  const config = overrides?.config ?? makeConfig(dir);
  if (overrides?.provider) (config as any).provider = overrides.provider;
  const { emit, events } = makeEmit();
  const session = new AgentSession({
    config,
    system: "Test assistant.",
    emit,
    generateSessionTitleImpl: mockGenerateSessionTitle,
    writePersistedSessionSnapshotImpl: mockWritePersistedSessionSnapshot,
  });
  return { session, events };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StreamChunkEvent = Extract<ServerEvent, { type: "model_stream_chunk" }>;

function getStreamChunks(events: ServerEvent[]): StreamChunkEvent[] {
  return events.filter((e): e is StreamChunkEvent => e.type === "model_stream_chunk");
}

/**
 * Set up mockRunTurn to call onModelStreamPart with the given raw parts,
 * then send a user message and return the collected events.
 */
async function sendWithStreamParts(
  session: InstanceType<typeof AgentSession>,
  rawParts: unknown[]
): Promise<void> {
  mockRunTurn.mockImplementationOnce(async (params: any) => {
    for (const rawPart of rawParts) {
      await params.onModelStreamPart(rawPart);
    }
    return { text: "", reasoningText: undefined, responseMessages: [] };
  });
  await session.sendUserMessage("test");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSession stream pipeline", () => {
  beforeEach(async () => {
    mockRunTurn.mockReset();
    mockRunTurn.mockImplementation(async () => ({
      text: "",
      reasoningText: undefined,
      responseMessages: [],
    }));
    await observabilityRuntimeInternal.resetForTests();
  });

  // =========================================================================
  // 1. tool-call
  // =========================================================================
  test("tool-call → model_stream_chunk with partType tool_call", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "read_file",
        input: { path: "/tmp/test.txt" },
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("tool_call");
    expect(chunks[0].part.toolCallId).toBe("tc-1");
    expect(chunks[0].part.toolName).toBe("read_file");
    expect(chunks[0].part.input).toEqual({ path: "/tmp/test.txt" });
  });

  // =========================================================================
  // 2. tool-result
  // =========================================================================
  test("tool-result → model_stream_chunk with partType tool_result", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-result",
        toolCallId: "tc-2",
        toolName: "read_file",
        output: "file contents here",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("tool_result");
    expect(chunks[0].part.toolCallId).toBe("tc-2");
    expect(chunks[0].part.toolName).toBe("read_file");
    expect(chunks[0].part.output).toBe("file contents here");
  });

  // =========================================================================
  // 3. tool-error
  // =========================================================================
  test("tool-error → model_stream_chunk with partType tool_error", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-error",
        toolCallId: "tc-3",
        toolName: "bash",
        error: "Command failed with exit code 1",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("tool_error");
    expect(chunks[0].part.toolCallId).toBe("tc-3");
    expect(chunks[0].part.toolName).toBe("bash");
    expect(chunks[0].part.error).toBe("Command failed with exit code 1");
  });

  // =========================================================================
  // 4. tool-output-denied
  // =========================================================================
  test("tool-output-denied → model_stream_chunk with partType tool_output_denied", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-output-denied",
        toolCallId: "tc-4",
        toolName: "bash",
        reason: "User denied execution",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("tool_output_denied");
    expect(chunks[0].part.toolCallId).toBe("tc-4");
    expect(chunks[0].part.toolName).toBe("bash");
    expect(chunks[0].part.reason).toBe("User denied execution");
  });

  // =========================================================================
  // 5. tool-input-start
  // =========================================================================
  test("tool-input-start → model_stream_chunk with partType tool_input_start", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-input-start",
        id: "tc-5",
        toolName: "write_file",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("tool_input_start");
    expect(chunks[0].part.id).toBe("tc-5");
    expect(chunks[0].part.toolName).toBe("write_file");
  });

  // =========================================================================
  // 6. tool-input-delta
  // =========================================================================
  test("tool-input-delta → model_stream_chunk with partType tool_input_delta", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-input-delta",
        id: "tc-6",
        delta: '{"path":"/tmp',
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("tool_input_delta");
    expect(chunks[0].part.id).toBe("tc-6");
    expect(chunks[0].part.delta).toBe('{"path":"/tmp');
  });

  // =========================================================================
  // 7. tool-input-end
  // =========================================================================
  test("tool-input-end → model_stream_chunk with partType tool_input_end", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-input-end",
        id: "tc-7",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("tool_input_end");
    expect(chunks[0].part.id).toBe("tc-7");
  });

  // =========================================================================
  // 8. tool-approval-request
  // =========================================================================
  test("tool-approval-request → model_stream_chunk with partType tool_approval_request", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-approval-request",
        approvalId: "apr-1",
        toolCall: {
          toolCallId: "tc-8",
          toolName: "bash",
          input: { command: "rm -rf /" },
        },
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("tool_approval_request");
    expect(chunks[0].part.approvalId).toBe("apr-1");
    expect(chunks[0].part.toolCall).toEqual({
      toolCallId: "tc-8",
      toolName: "bash",
      input: { command: "rm -rf /" },
    });
  });

  // =========================================================================
  // 9. start-step
  // =========================================================================
  test("start-step → model_stream_chunk with partType start_step", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "start-step",
        stepNumber: 0,
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("start_step");
    expect(chunks[0].part.stepNumber).toBe(0);
  });

  // =========================================================================
  // 10. finish-step
  // =========================================================================
  test("finish-step → model_stream_chunk with partType finish_step", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "finish-step",
        stepNumber: 0,
        finishReason: "tool-calls",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("finish_step");
    expect(chunks[0].part.stepNumber).toBe(0);
    expect(chunks[0].part.finishReason).toBe("tool-calls");
  });

  // =========================================================================
  // 11. abort
  // =========================================================================
  test("abort → model_stream_chunk with partType abort", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "abort",
        reason: "User cancelled",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("abort");
    expect(chunks[0].part.reason).toBe("User cancelled");
  });

  // =========================================================================
  // 12. error
  // =========================================================================
  test("error → model_stream_chunk with partType error", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "error",
        error: "Rate limit exceeded",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("error");
    expect(chunks[0].part.error).toBe("Rate limit exceeded");
  });

  // =========================================================================
  // 13. text-start
  // =========================================================================
  test("text-start → model_stream_chunk with partType text_start", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "text-start",
        id: "txt-1",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("text_start");
  });

  // =========================================================================
  // 14. text-end
  // =========================================================================
  test("text-end → model_stream_chunk with partType text_end", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "text-end",
        id: "txt-1",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("text_end");
  });

  // =========================================================================
  // 15. reasoning-start
  // =========================================================================
  test("reasoning-start → model_stream_chunk with partType reasoning_start", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "reasoning-start",
        id: "r-1",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("reasoning_start");
  });

  // =========================================================================
  // 16. reasoning-end
  // =========================================================================
  test("reasoning-end → model_stream_chunk with partType reasoning_end", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "reasoning-end",
        id: "r-1",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("reasoning_end");
  });

  // =========================================================================
  // 17. source
  // =========================================================================
  test("source → model_stream_chunk with partType source", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "source",
        url: "https://example.com",
        title: "Example",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("source");
    expect(chunks[0].part.source).toBeDefined();
    const source = chunks[0].part.source as Record<string, unknown>;
    expect(source.url).toBe("https://example.com");
    expect(source.title).toBe("Example");
  });

  // =========================================================================
  // 18. file
  // =========================================================================
  test("file → model_stream_chunk with partType file", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "file",
        file: { name: "output.png", mimeType: "image/png" },
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("file");
  });

  // =========================================================================
  // 19. unknown type
  // =========================================================================
  test("unknown type → model_stream_chunk with partType unknown", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "some-future-sdk-type",
        data: "hello",
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partType).toBe("unknown");
    expect(chunks[0].part.sdkType).toBe("some-future-sdk-type");
  });

  // =========================================================================
  // 20. Multi-step sequence
  // =========================================================================
  test("multi-step sequence arrives in order with correct indices", async () => {
    const { session, events } = makeSession();
    const sequence = [
      { type: "start" },
      { type: "start-step", stepNumber: 0 },
      { type: "tool-input-start", id: "tc-seq", toolName: "bash" },
      { type: "tool-input-delta", id: "tc-seq", delta: '{"command":"ls"}' },
      { type: "tool-input-end", id: "tc-seq" },
      { type: "tool-call", toolCallId: "tc-seq", toolName: "bash", input: { command: "ls" } },
      { type: "tool-result", toolCallId: "tc-seq", toolName: "bash", output: "file1.txt\nfile2.txt" },
      { type: "finish-step", stepNumber: 0, finishReason: "tool-calls" },
      { type: "start-step", stepNumber: 1 },
      { type: "text-start", id: "txt-seq" },
      { type: "text-delta", id: "txt-seq", text: "Here are your files." },
      { type: "text-end", id: "txt-seq" },
      { type: "finish-step", stepNumber: 1, finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ];

    await sendWithStreamParts(session, sequence);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(sequence.length);

    // Verify indices are sequential
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }

    // Verify the expected partType sequence
    const expectedPartTypes = [
      "start",
      "start_step",
      "tool_input_start",
      "tool_input_delta",
      "tool_input_end",
      "tool_call",
      "tool_result",
      "finish_step",
      "start_step",
      "text_start",
      "text_delta",
      "text_end",
      "finish_step",
      "finish",
    ];
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].partType).toBe(expectedPartTypes[i]);
    }

    // Verify step numbers
    const startStep0 = chunks[1];
    expect(startStep0.part.stepNumber).toBe(0);
    const finishStep0 = chunks[7];
    expect(finishStep0.part.stepNumber).toBe(0);
    expect(finishStep0.part.finishReason).toBe("tool-calls");
    const startStep1 = chunks[8];
    expect(startStep1.part.stepNumber).toBe(1);
    const finishStep1 = chunks[12];
    expect(finishStep1.part.stepNumber).toBe(1);
    expect(finishStep1.part.finishReason).toBe("stop");

    // Verify tool call/result correlation
    const toolCall = chunks[5];
    expect(toolCall.part.toolCallId).toBe("tc-seq");
    expect(toolCall.part.toolName).toBe("bash");
    const toolResult = chunks[6];
    expect(toolResult.part.toolCallId).toBe("tc-seq");
    expect(toolResult.part.output).toBe("file1.txt\nfile2.txt");

    // Verify all chunks belong to the same turn
    const turnId = chunks[0].turnId;
    for (const chunk of chunks) {
      expect(chunk.turnId).toBe(turnId);
    }
  });

  // =========================================================================
  // 21. rawPart forwarding
  // =========================================================================
  test("rawPart is included in emitted chunk (includeRawPart is true by default in session)", async () => {
    const { session, events } = makeSession();
    const rawInput = {
      type: "tool-call",
      toolCallId: "tc-raw",
      toolName: "grep",
      input: { pattern: "foo" },
    };
    await sendWithStreamParts(session, [rawInput]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    // rawPart should be present and reflect the sanitized raw input
    expect(chunks[0].rawPart).toBeDefined();
    const rawPart = chunks[0].rawPart as Record<string, unknown>;
    expect(rawPart.type).toBe("tool-call");
    expect(rawPart.toolCallId).toBe("tc-raw");
    expect(rawPart.toolName).toBe("grep");
    expect(rawPart.input).toEqual({ pattern: "foo" });
  });

  // =========================================================================
  // 22. Provider-specific reasoning mode
  // =========================================================================
  describe("provider-specific reasoning mode", () => {
    test("reasoning-delta with openai provider gets mode: summary", async () => {
      const { session, events } = makeSession({ provider: "openai" });
      await sendWithStreamParts(session, [
        {
          type: "reasoning-delta",
          id: "r-openai",
          text: "Thinking about this...",
        },
      ]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_delta");
      expect(chunks[0].part.mode).toBe("summary");
      expect(chunks[0].part.text).toBe("Thinking about this...");
      expect(chunks[0].provider).toBe("openai");
    });

    test("reasoning-delta with google provider gets mode: reasoning", async () => {
      const { session, events } = makeSession({ provider: "google" });
      await sendWithStreamParts(session, [
        {
          type: "reasoning-delta",
          id: "r-google",
          text: "Let me reason through this...",
        },
      ]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_delta");
      expect(chunks[0].part.mode).toBe("reasoning");
      expect(chunks[0].part.text).toBe("Let me reason through this...");
      expect(chunks[0].provider).toBe("google");
    });

    test("reasoning-start with openai provider gets mode: summary", async () => {
      const { session, events } = makeSession({ provider: "openai" });
      await sendWithStreamParts(session, [
        { type: "reasoning-start", id: "r-openai-start" },
      ]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_start");
      expect(chunks[0].part.mode).toBe("summary");
    });

    test("reasoning-end with openai provider gets mode: summary", async () => {
      const { session, events } = makeSession({ provider: "openai" });
      await sendWithStreamParts(session, [
        { type: "reasoning-end", id: "r-openai-end" },
      ]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_end");
      expect(chunks[0].part.mode).toBe("summary");
    });

    test("reasoning-start with google provider gets mode: reasoning", async () => {
      const { session, events } = makeSession({ provider: "google" });
      await sendWithStreamParts(session, [
        { type: "reasoning-start", id: "r-google-start" },
      ]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_start");
      expect(chunks[0].part.mode).toBe("reasoning");
    });

    test("reasoning-delta with anthropic provider gets mode: reasoning", async () => {
      const { session, events } = makeSession({ provider: "anthropic" });
      await sendWithStreamParts(session, [
        {
          type: "reasoning-delta",
          id: "r-anthropic",
          text: "Reasoning deeply...",
        },
      ]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_delta");
      expect(chunks[0].part.mode).toBe("reasoning");
    });

    test("reasoning-delta with codex-cli provider gets mode: summary", async () => {
      const { session, events } = makeSession({ provider: "codex-cli" });
      await sendWithStreamParts(session, [
        {
          type: "reasoning-delta",
          id: "r-codex",
          text: "Summarizing...",
        },
      ]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_delta");
      expect(chunks[0].part.mode).toBe("summary");
    });
  });
});
