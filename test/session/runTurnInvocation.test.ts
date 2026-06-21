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
});
