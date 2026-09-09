import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createRunTurn } from "../src/agent";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";
import { scratchRoots } from "../src/platform/sandbox";
import {
  type CodexAppServerJsonRpcNotification,
  closePooledCodexAppServerClients,
  __internal as codexAppServerClientInternal,
} from "../src/providers/codexAppServerClient";
import { createCodexAppServerRuntime } from "../src/runtime/codexAppServerRuntime";
import type { SessionEvent } from "../src/server/protocol";
import { AgentSession } from "../src/server/session/AgentSession";
import { createAgentSessionFromPersisted } from "../src/server/session/AgentSessionFromPersisted";
import { type PersistedModelStreamChunk, SessionDb } from "../src/server/sessionDb";
import type { AgentConfig } from "../src/types";
import { createMockClient } from "./fixtures/codexAppServerMock";

const mockRunTurn = mock(async () => ({
  text: "",
  reasoningText: undefined as string | undefined,
  responseMessages: [] as any[],
}));

const mockGenerateSessionTitle = mock(async () => ({
  title: "Mock title",
  source: "heuristic" as const,
  model: null as string | null,
}));

const mockWritePersistedSessionSnapshot = mock(async () => "/tmp/mock.json");

function makeConfig(dir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

function makeEmit(): { emit: (evt: SessionEvent) => void; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  return {
    emit: (event: SessionEvent) => {
      events.push(event);
    },
    events,
  };
}

function makeSession(overrides?: {
  config?: AgentConfig;
  provider?: string;
  sessionDb?: Partial<SessionDb>;
}) {
  const dir = "/tmp/test-session";
  const config = overrides?.config ?? makeConfig(dir);
  if (overrides?.provider) (config as any).provider = overrides.provider;
  const { emit, events } = makeEmit();
  const session = new AgentSession({
    config,
    system: "Test assistant.",
    discoveredSkills: [{ name: "test-skill", description: "Test skill" }],
    emit,
    generateSessionTitleImpl: mockGenerateSessionTitle,
    writePersistedSessionSnapshotImpl: mockWritePersistedSessionSnapshot,
    runTurnImpl: mockRunTurn,
    sessionDb: overrides?.sessionDb as SessionDb | undefined,
  });
  return { session, events };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StreamChunkEvent = Extract<SessionEvent, { type: "model_stream_chunk" }>;
type RawStreamEvent = Extract<SessionEvent, { type: "model_stream_raw" }>;

function getStreamChunks(events: SessionEvent[]): StreamChunkEvent[] {
  return events.filter((e): e is StreamChunkEvent => e.type === "model_stream_chunk");
}

function getRawStreamEvents(events: SessionEvent[]): RawStreamEvent[] {
  return events.filter((e): e is RawStreamEvent => e.type === "model_stream_raw");
}

/**
 * Set up mockRunTurn to call onModelStreamPart with the given raw parts,
 * then send a user message and return the collected events.
 */
async function sendWithStreamParts(
  session: InstanceType<typeof AgentSession>,
  rawParts: unknown[],
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

  test("persists completed Codex tools queued behind a stream callback before cancellation", async () => {
    const [scratchRoot] = scratchRoots();
    if (!scratchRoot) throw new Error("No platform scratch root is available");
    const dir = await fs.mkdtemp(path.join(scratchRoot, "session-codex-queued-progress-"));
    const config: AgentConfig = {
      ...makeConfig(dir),
      provider: "codex-cli",
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
      userCoworkDir: path.join(dir, "home", ".cowork"),
      builtInDir: path.resolve("."),
      builtInConfigDir: path.resolve("config"),
      enableMcp: false,
    };
    const sessionDb = await SessionDb.create({
      paths: {
        rootDir: config.userCoworkDir,
        sessionsDir: path.join(config.userCoworkDir, "sessions"),
      },
    });
    const turnStarted = Promise.withResolvers<void>();
    const callbackEntered = Promise.withResolvers<void>();
    const releaseCallback = Promise.withResolvers<void>();
    const listeners = new Set<(notification: CodexAppServerJsonRpcNotification) => void>();
    const turnRequests: Record<string, unknown>[] = [];
    const emitNotification = (
      method: string,
      payload: Record<string, unknown>,
      turnId = "turn_1",
    ) => {
      for (const listener of listeners) {
        listener({ method, params: { threadId: "thread_1", turnId, ...payload } });
      }
    };
    codexAppServerClientInternal.setClientFactoryForTests(async () => {
      const client = createMockClient();
      const request = client.request.bind(client);
      client.onNotification = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      client.request = async (method, params, timeout, opts) => {
        if (method !== "turn/start") return await request(method, params, timeout, opts);
        turnRequests.push(structuredClone(params as Record<string, unknown>));
        const turnId = `turn_${turnRequests.length}`;
        if (turnRequests.length === 1) {
          turnStarted.resolve();
        } else {
          queueMicrotask(() => {
            emitNotification(
              "turn/completed",
              { turn: { id: turnId, status: "completed", items: [], error: null } },
              turnId,
            );
          });
        }
        return { turn: { id: turnId, status: "inProgress", items: [] } };
      };
      client.interruptTurn = async () => {};
      return client;
    });
    const runtime = createCodexAppServerRuntime();
    let heldCallback = false;
    const realRunTurn = createRunTurn({
      createTools: () => ({}),
      createRuntime: () => ({
        name: runtime.name,
        runTurn: async (params) =>
          await runtime.runTurn({
            ...params,
            onModelStreamPart: async (part) => {
              if ((part as { type?: string }).type === "text-delta" && !heldCallback) {
                heldCallback = true;
                callbackEntered.resolve();
                await releaseCallback.promise;
              }
              await params.onModelStreamPart?.(part);
            },
          }),
      }),
    });
    const runTurnImpl: typeof realRunTurn = async (params) =>
      await realRunTurn({ ...params, toolEnv: { COWORK_DISABLE_RUNTIME: "1" } });
    const { emit, events } = makeEmit();
    const session = new AgentSession({
      config,
      system: "Test assistant.",
      discoveredSkills: [],
      emit,
      yolo: true,
      sessionDb,
      runTurnImpl,
      getProviderStatusesImpl: async () => [],
      generateSessionTitleImpl: mockGenerateSessionTitle,
      writePersistedSessionSnapshotImpl: mockWritePersistedSessionSnapshot,
    });
    let restored: AgentSession | undefined;
    const code = 'await tools.writeFile({ path: "note.txt", content: "saved" })';
    const turn = session.sendUserMessage("Save a note using Code Mode.");
    try {
      await turnStarted.promise;
      emitNotification("item/started", {
        item: { type: "agentMessage", id: "held-text", text: "" },
      });
      emitNotification("item/agentMessage/delta", { itemId: "held-text", delta: "Working" });
      await callbackEntered.promise;
      emitNotification("rawResponseItem/completed", {
        item: { type: "custom_tool_call", call_id: "saved-exec", name: "exec", input: code },
      });
      await fs.writeFile(path.join(dir, "note.txt"), "saved", "utf8");
      emitNotification("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: "saved-exec",
          output: "saved via code mode",
        },
      });
      emitNotification("item/started", {
        item: { type: "commandExecution", id: "unfinished", command: "slow command", cwd: dir },
      });
      emitNotification("item/commandExecution/outputDelta", {
        itemId: "unfinished",
        delta: "preliminary output",
      });
      session.cancel();
      emitNotification("item/completed", {
        item: {
          type: "commandExecution",
          id: "unfinished",
          command: "slow command",
          aggregatedOutput: "late result",
          exitCode: 0,
        },
      });
      emitNotification("turn/completed", {
        turn: { id: "turn_1", status: "interrupted", items: [], error: null },
      });
      releaseCallback.resolve();
      await turn;
      await session.waitForPersistenceIdle({ throwOnError: true });

      expect(session.currentTurnOutcome).toBe("cancelled");
      const persisted = sessionDb.getSessionRecord(session.id);
      expect(persisted?.messages).toHaveLength(3);
      expect(persisted?.providerState).toBeNull();
      expect(persisted?.messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "saved-exec", input: code }],
      });
      const serialized = JSON.stringify(persisted?.messages);
      expect(serialized).toContain("saved via code mode");
      expect(serialized).not.toContain("preliminary output");
      expect(serialized).not.toContain("late result");
      expect(serialized).not.toContain("unfinished");
      expect(JSON.stringify(events)).not.toContain("saved via code mode");
      expect(await fs.readFile(path.join(dir, "note.txt"), "utf8")).toBe("saved");

      await session.sendUserMessage("Continue without repeating the completed write.");
      expect(JSON.stringify(turnRequests[1]?.input)).toContain("saved via code mode");
      expect(JSON.stringify(turnRequests[1]?.input)).toContain("saved-exec");
      session.dispose("restart after cancellation");
      await session.waitForPersistenceIdle();
      restored = createAgentSessionFromPersisted({
        persisted: persisted!,
        baseConfig: config,
        discoveredSkills: [],
        emit: () => {},
        yolo: true,
        sessionDb,
        runTurnImpl,
        getProviderStatusesImpl: async () => [],
        generateSessionTitleImpl: mockGenerateSessionTitle,
        writePersistedSessionSnapshotImpl: mockWritePersistedSessionSnapshot,
      });
      await restored.sendUserMessage("Resume from the saved tool result after restart.");
      expect(turnRequests).toHaveLength(3);
      expect(JSON.stringify(turnRequests[2]?.input)).toContain("saved via code mode");
      expect(JSON.stringify(turnRequests[2]?.input)).toContain("saved-exec");
      expect(JSON.stringify(turnRequests[2]?.input)).not.toContain("late result");
    } finally {
      releaseCallback.resolve();
      session.cancel();
      await turn;
      session.dispose("test complete");
      restored?.dispose("test complete");
      await session.waitForPersistenceIdle();
      await restored?.waitForPersistenceIdle();
      await closePooledCodexAppServerClients();
      codexAppServerClientInternal.setClientFactoryForTests(undefined);
      sessionDb.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("provider raw stream events are emitted and redundant normalized chunks are suppressed for raw-backed replay", async () => {
    const { session, events } = makeSession();
    mockRunTurn.mockImplementationOnce(async (params: any) => {
      await params.onModelRawEvent?.({
        format: "openai-responses-v1",
        event: {
          type: "response.output_item.added",
          item: { type: "reasoning", id: "rs_1", summary: [] },
        },
      });
      await params.onModelStreamPart({
        type: "reasoning-start",
        id: "s0",
        mode: "summary",
      });
      return { text: "", reasoningText: undefined, responseMessages: [] };
    });

    await session.sendUserMessage("test");

    const rawEvents = getRawStreamEvents(events);
    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0]).toMatchObject({
      format: "openai-responses-v1",
      event: {
        type: "response.output_item.added",
      },
    });

    const rawIndex = events.findIndex((evt) => evt.type === "model_stream_raw");
    const chunkIndex = events.findIndex((evt) => evt.type === "model_stream_chunk");
    expect(rawIndex).toBeGreaterThanOrEqual(0);
    // Redundant normalized stream chunk is suppressed for raw-backed replay
    expect(chunkIndex).toBe(-1);
  });

  test.each([
    {
      label: "Codex app-server diagnostics",
      provider: "codex-cli",
      format: "codex-app-server-v2",
      event: {
        direction: "client_request",
        message: { id: 4, method: "turn/start", params: { threadId: "thread-1" } },
      },
    },
    {
      label: "unknown raw provider events",
      provider: "openai",
      format: "openai-responses-v1",
      event: { type: "response.unknown_future_event" },
    },
    {
      label: "raw native web-search activity",
      provider: "openai",
      format: "openai-responses-v1",
      event: {
        type: "response.output_item.added",
        item: {
          id: "web-search-1",
          type: "web_search_call",
          action: { type: "search", query: "example" },
        },
      },
    },
  ])("keeps normalized text and tool input after $label", async ({ provider, format, event }) => {
    const { session, events } = makeSession({ provider });
    mockRunTurn.mockImplementationOnce(async (params: any) => {
      await params.onModelRawEvent?.({ format, event });
      for (const part of [
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", text: "Visible streaming output." },
        { type: "text-end", id: "answer" },
        { type: "tool-input-start", id: "read-1", toolName: "read" },
        {
          type: "tool-call",
          toolCallId: "read-1",
          toolName: "read",
          input: { path: "result.txt" },
        },
        { type: "tool-result", toolCallId: "read-1", toolName: "read", output: "contents" },
      ]) {
        await params.onModelStreamPart(part);
      }
      return { text: "", reasoningText: undefined, responseMessages: [] };
    });

    await session.sendUserMessage("show streaming output");

    const chunks = getStreamChunks(events);
    expect(chunks.map((chunk) => chunk.partType)).toEqual([
      "text_start",
      "text_delta",
      "text_end",
      "tool_input_start",
      "tool_call",
      "tool_result",
    ]);
    expect(chunks.find((chunk) => chunk.partType === "text_delta")?.part.text).toBe(
      "Visible streaming output.",
    );
    expect(chunks.find((chunk) => chunk.partType === "tool_call")?.part.input).toEqual({
      path: "result.txt",
    });
  });

  test("codex app-server raw JSON-RPC requests persist through the SQLite raw stream path", async () => {
    const persisted: PersistedModelStreamChunk[] = [];
    const sessionDb = {
      persistModelStreamChunk: mock(async (chunk: PersistedModelStreamChunk) => {
        persisted.push(chunk);
      }),
    };
    const { session, events } = makeSession({
      provider: "codex-cli",
      sessionDb,
    });
    mockRunTurn.mockImplementationOnce(async (params: any) => {
      await params.onModelRawEvent?.({
        format: "codex-app-server-v2",
        event: {
          direction: "client_request",
          message: {
            id: 4,
            method: "turn/start",
            params: {
              threadId: "thread_1",
              input: [{ type: "text", text: "test", text_elements: [] }],
            },
          },
        },
      });
      return { text: "", reasoningText: undefined, responseMessages: [] };
    });

    await session.sendUserMessage("test");

    const rawEvents = getRawStreamEvents(events);
    expect(rawEvents).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      provider: "codex-cli",
      rawFormat: "codex-app-server-v2",
      rawEvent: rawEvents[0].event,
    });
    expect(persisted[0].rawEvent).toEqual({
      direction: "client_request",
      message: {
        id: 4,
        method: "turn/start",
        params: {
          threadId: "thread_1",
          input: [{ type: "text", text: "test", text_elements: [] }],
        },
      },
    });
  });

  test("batches optional raw model diagnostics instead of locking the database for every token", async () => {
    const persistedBatches: PersistedModelStreamChunk[][] = [];
    const persistModelStreamChunk = mock(async () => {});
    const persistModelStreamChunks = mock(async (chunks: PersistedModelStreamChunk[]) => {
      persistedBatches.push([...chunks]);
    });
    const { session, events } = makeSession({
      sessionDb: {
        persistSessionMutation: async () => 1,
        persistSessionSnapshot: async () => {},
        persistModelStreamChunk,
        persistModelStreamChunks,
      } as never,
    });
    mockRunTurn.mockImplementationOnce(async (params: any) => {
      for (let index = 0; index < 130; index += 1) {
        await params.onModelRawEvent?.({
          format: "openai-responses-v1",
          event: { type: "response.output_text.delta", delta: String(index) },
        });
      }
      return { text: "stream complete", reasoningText: undefined, responseMessages: [] };
    });

    await session.sendUserMessage("stream many tokens");

    expect(persistModelStreamChunk).not.toHaveBeenCalled();
    expect(persistedBatches.map((batch) => batch.length)).toEqual([64, 64, 2]);
    expect(persistedBatches.flat().map((chunk) => chunk.chunkIndex)).toEqual(
      Array.from({ length: 130 }, (_, index) => index),
    );
    expect(
      events.some(
        (event) => event.type === "assistant_message" && event.text === "stream complete",
      ),
    ).toBe(true);
  });

  test("keeps a successful assistant response when optional raw diagnostics cannot be persisted", async () => {
    const { session, events } = makeSession({
      sessionDb: {
        persistSessionMutation: async () => 1,
        persistSessionSnapshot: async () => {},
        persistModelStreamChunk: async () => {
          throw new Error("raw diagnostics database is locked");
        },
      } as never,
    });
    mockRunTurn.mockImplementationOnce(async (params: any) => {
      await params.onModelRawEvent?.({
        format: "openai-responses-v1",
        event: { type: "response.output_text.delta", delta: "useful" },
      });
      return { text: "useful answer", reasoningText: undefined, responseMessages: [] };
    });

    await session.sendUserMessage("answer even if diagnostics fail");

    expect(
      events.some((event) => event.type === "assistant_message" && event.text === "useful answer"),
    ).toBe(true);
    expect(session.getSessionInfoEvent().executionState).toBe("completed");
    expect(events.some((event) => event.type === "error")).toBe(false);
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

  test("tool-result overflow companion file emits adjacent tool_result and file chunks", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      {
        type: "tool-result",
        toolCallId: "tc-overflow",
        toolName: "bash",
        output: {
          type: "text",
          value: "Tool output overflowed. Saved to /tmp/workspace/.ModelScratchpad/spill.txt",
          overflow: true,
          filePath: "/tmp/workspace/.ModelScratchpad/spill.txt",
          chars: 30000,
          preview: "preview",
        },
      },
      {
        type: "file",
        file: {
          kind: "tool-output-overflow",
          toolName: "bash",
          toolCallId: "tc-overflow",
          path: "/tmp/workspace/.ModelScratchpad/spill.txt",
          chars: 30000,
          preview: "preview",
        },
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].partType).toBe("tool_result");
    expect((chunks[0].part.output as Record<string, unknown>).overflow).toBe(true);
    expect(chunks[1].partType).toBe("file");
    expect((chunks[1].part.file as Record<string, unknown>).kind).toBe("tool-output-overflow");
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

  test("id-less tool lifecycle keeps one fallback key across input and result chunks", async () => {
    const { session, events } = makeSession();
    await sendWithStreamParts(session, [
      { type: "tool-input-start", toolName: "bash" },
      { type: "tool-input-delta", delta: '{"command":"ls"' },
      { type: "tool-input-end" },
      { type: "tool-call", toolName: "bash", input: { command: "ls" } },
      { type: "tool-result", toolName: "bash", output: "ok" },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(5);

    const fallbackKey = chunks[0].part.id;
    expect(typeof fallbackKey).toBe("string");
    expect(fallbackKey).toBe(`anon:${chunks[0].turnId}:tool`);
    expect(chunks[1].part.id).toBe(fallbackKey);
    expect(chunks[2].part.id).toBe(fallbackKey);
    expect(chunks[3].part.toolCallId).toBe(fallbackKey);
    expect(chunks[4].part.toolCallId).toBe(fallbackKey);
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
    expect(chunks[0].part.file).toEqual({ name: "output.png", mimeType: "image/png" });
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
      {
        type: "tool-result",
        toolCallId: "tc-seq",
        toolName: "bash",
        output: "file1.txt\nfile2.txt",
      },
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

  test("rawPart is omitted when includeRawChunks is disabled in config", async () => {
    const config = makeConfig("/tmp/test-session");
    config.includeRawChunks = false;
    const { session, events } = makeSession({ config });

    await sendWithStreamParts(session, [
      {
        type: "tool-call",
        toolCallId: "tc-no-raw",
        toolName: "grep",
        input: { pattern: "foo" },
      },
    ]);

    const chunks = getStreamChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].rawPart).toBeUndefined();
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
      await sendWithStreamParts(session, [{ type: "reasoning-start", id: "r-openai-start" }]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_start");
      expect(chunks[0].part.mode).toBe("summary");
    });

    test("reasoning-end with openai provider gets mode: summary", async () => {
      const { session, events } = makeSession({ provider: "openai" });
      await sendWithStreamParts(session, [{ type: "reasoning-end", id: "r-openai-end" }]);

      const chunks = getStreamChunks(events);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].partType).toBe("reasoning_end");
      expect(chunks[0].part.mode).toBe("summary");
    });

    test("reasoning-start with google provider gets mode: reasoning", async () => {
      const { session, events } = makeSession({ provider: "google" });
      await sendWithStreamParts(session, [{ type: "reasoning-start", id: "r-google-start" }]);

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
