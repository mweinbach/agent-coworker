import { describe, expect, mock, test } from "bun:test";

import type { RunTurnParams } from "../../src/agent";
import type { SessionContext } from "../../src/server/session/SessionContext";
import { createRunTurnInvocation } from "../../src/server/session/turnExecution/runTurnInvocation";
import type { SteerCoordinator } from "../../src/server/session/turnExecution/steerCoordinator";
import { makeConfig } from "./agentSession.harness";

describe("createRunTurnInvocation", () => {
  test("surfaces MCP load errors as session logs and telemetry", async () => {
    const log = mock((_line: string) => {});
    const emitTelemetry = mock(
      (
        _name: string,
        _status: "ok" | "error",
        _attributes?: Record<string, string | number | boolean>,
      ) => {},
    );
    const runTurnImpl = mock(async (params: RunTurnParams) => {
      params.onMcpLoadErrors?.(["server failed to start", "[MCP] cached server timed out"]);
      return { text: "", reasoningText: undefined, responseMessages: [] };
    });
    const steerCoordinator = {
      drainPendingSteers: mock(async () => undefined),
    } as unknown as SteerCoordinator;
    const context = {
      id: "session-123",
      state: {
        config: makeConfig("/tmp/run-turn-invocation"),
        system: "System prompt",
        messages: [],
        allMessages: [],
        providerState: null,
        turnReferencedPlugins: [],
        discoveredSkills: [],
        yolo: false,
        maxSteps: 100,
        abortController: null,
        costTracker: null,
        sessionInfo: {
          sessionKind: "root",
          role: null,
          profile: null,
          depth: 0,
          targetPaths: null,
        },
      },
      deps: {
        harnessContextStore: { get: mock(() => null) },
        runTurnImpl,
        toolEnv: { PATH: "/usr/bin" },
      },
      emitTelemetry,
    } as unknown as SessionContext;

    const invokeRunTurn = createRunTurnInvocation({
      context,
      turnId: "turn-123",
      steerCoordinator,
      log,
      askUser: async () => "",
      approveCommand: async () => true,
      updateTodos: () => {},
      tracker: {
        startedStepCount: 0,
        streamPartIndex: 0,
        rawStreamEventIndex: 0,
        lastStreamError: null,
        turnAnnouncedAtMs: null,
        firstOutputObserved: false,
      },
      includeRawChunks: false,
      setAcceptingSteers: () => {},
    });

    await invokeRunTurn(10);

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "[MCP] server failed to start",
      "[MCP] cached server timed out",
    ]);
    expect(emitTelemetry).toHaveBeenCalledWith("agent.mcp.load_errors", "error", {
      sessionId: "session-123",
      count: 2,
    });
  });

  test("emits time-to-first-output telemetry on the first visible delta only", async () => {
    const emitTelemetry = mock(
      (
        _name: string,
        _status: "ok" | "error",
        _attributes?: Record<string, string | number | boolean>,
        _durationMs?: number,
      ) => {},
    );
    const runTurnImpl = mock(async (params: RunTurnParams) => {
      await params.onModelStreamPart?.({ type: "text-delta", id: "t1", text: "Hel" } as never);
      await params.onModelStreamPart?.({ type: "text-delta", id: "t1", text: "lo" } as never);
      return { text: "Hello", reasoningText: undefined, responseMessages: [] };
    });
    const steerCoordinator = {
      drainPendingSteers: mock(async () => undefined),
    } as unknown as SteerCoordinator;
    const config = makeConfig("/tmp/run-turn-invocation");
    const context = {
      id: "session-456",
      state: {
        config,
        system: "System prompt",
        messages: [],
        allMessages: [],
        providerState: null,
        turnReferencedPlugins: [],
        discoveredSkills: [],
        yolo: false,
        maxSteps: 100,
        abortController: null,
        costTracker: null,
        sessionInfo: {
          sessionKind: "root",
          role: null,
          profile: null,
          depth: 0,
          targetPaths: null,
        },
      },
      deps: {
        harnessContextStore: { get: mock(() => null) },
        runTurnImpl,
        toolEnv: { PATH: "/usr/bin" },
      },
      emit: mock(() => {}),
      emitTelemetry,
    } as unknown as SessionContext;

    const invokeRunTurn = createRunTurnInvocation({
      context,
      turnId: "turn-456",
      steerCoordinator,
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => true,
      updateTodos: () => {},
      tracker: {
        startedStepCount: 0,
        streamPartIndex: 0,
        rawStreamEventIndex: 0,
        lastStreamError: null,
        turnAnnouncedAtMs: Date.now(),
        firstOutputObserved: false,
      },
      includeRawChunks: false,
      setAcceptingSteers: () => {},
    });

    await invokeRunTurn(10);

    const firstOutputCalls = emitTelemetry.mock.calls.filter(
      ([name]) => name === "agent.turn.first_output",
    );
    expect(firstOutputCalls).toHaveLength(1);
    const [, status, attributes, durationMs] = firstOutputCalls[0] ?? [];
    expect(status).toBe("ok");
    expect(attributes).toMatchObject({
      sessionId: "session-456",
      turnId: "turn-456",
      provider: config.provider,
      model: config.model,
      partType: "text_delta",
    });
    expect(typeof durationMs).toBe("number");
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  test("attaches retry lineage only to the first exact replacement invocation", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const runTurnImpl = mock(async (params: RunTurnParams) => {
      await params.onModelStreamPart?.({
        type: "tool-call",
        toolCallId: "wrong-tool",
        toolName: "read",
        input: { command: "bun test" },
      } as never);
      await params.onModelStreamPart?.({
        type: "tool-call",
        toolCallId: "wrong-args",
        toolName: "bash",
        input: { command: "bun test --watch" },
      } as never);
      await params.onModelStreamPart?.({
        type: "tool-call",
        toolCallId: "replacement",
        toolName: "bash",
        input: { command: "bun test" },
      } as never);
      await params.onModelStreamPart?.({
        type: "tool-call",
        toolCallId: "duplicate",
        toolName: "bash",
        input: { command: "bun test" },
      } as never);
      return { text: "", reasoningText: undefined, responseMessages: [] };
    });
    const context = {
      id: "session-retry",
      state: {
        config: makeConfig("/tmp/run-turn-retry"),
        system: "System prompt",
        messages: [],
        allMessages: [],
        providerState: null,
        turnReferencedPlugins: [],
        discoveredSkills: [],
        yolo: false,
        maxSteps: 100,
        abortController: null,
        costTracker: null,
        sessionInfo: {
          sessionKind: "root",
          role: null,
          profile: null,
          depth: 0,
          targetPaths: null,
        },
      },
      deps: {
        harnessContextStore: { get: mock(() => null) },
        runTurnImpl,
        toolEnv: { PATH: "/usr/bin" },
      },
      emit: (event: Record<string, unknown>) => emitted.push(event),
      emitTelemetry: mock(() => {}),
    } as unknown as SessionContext;
    const invokeRunTurn = createRunTurnInvocation({
      context,
      turnId: "turn-retry",
      steerCoordinator: {
        drainPendingSteers: mock(async () => undefined),
      } as unknown as SteerCoordinator,
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => true,
      updateTodos: () => {},
      tracker: {
        startedStepCount: 0,
        streamPartIndex: 0,
        rawStreamEventIndex: 0,
        lastStreamError: null,
        turnAnnouncedAtMs: null,
        firstOutputObserved: false,
      },
      includeRawChunks: false,
      setAcceptingSteers: () => {},
      toolRetryIntent: {
        targets: [
          {
            itemId: "toolCall:previous-turn:failed",
            toolName: "bash",
            argsFingerprint: '{"command":"bun test"}',
          },
        ],
      },
    });

    await invokeRunTurn(10);

    const toolCalls = emitted
      .filter((event) => event.type === "model_stream_chunk")
      .map((event) => event.part)
      .filter(
        (part): part is Record<string, unknown> =>
          typeof part === "object" && part !== null && "toolCallId" in part,
      );
    expect(toolCalls).toEqual([
      {
        toolCallId: "wrong-tool",
        toolName: "read",
        input: { command: "bun test" },
      },
      {
        toolCallId: "wrong-args",
        toolName: "bash",
        input: { command: "bun test --watch" },
      },
      {
        toolCallId: "replacement",
        toolName: "bash",
        input: { command: "bun test" },
        retryOf: "toolCall:previous-turn:failed",
      },
      {
        toolCallId: "duplicate",
        toolName: "bash",
        input: { command: "bun test" },
      },
    ]);
  });
});
