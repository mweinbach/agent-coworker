import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

import type { RunTurnParams } from "../src/agent";
import { __internal as agentInternal, createRunTurn } from "../src/agent";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";
import type { AgentConfig } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = "/tmp/agent-mutation-gate-test";
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
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
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] as never[],
    toolEnv: { COWORK_DISABLE_RUNTIME: "1" },
    log: mock(() => {}),
    askUser: mock(async () => "yes"),
    approveCommand: mock(async () => true),
    ...overrides,
  };
}

describe("runTurn mutation gate wrapping", () => {
  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();
    agentInternal.setStreamDrainTimeoutMs(500);
  });

  afterEach(() => {
    agentInternal.resetStreamDrainTimeoutMs();
    mock.restore();
  });

  test("wraps tool execute with assertCanMutate before the underlying tool runs", async () => {
    const order: string[] = [];
    const assertCanMutate = mock(async (toolName: string) => {
      order.push(`gate:${toolName}`);
    });
    const writeExecute = mock(async () => {
      order.push("execute:write");
      return { ok: true };
    });
    const createTools = mock(() => ({
      write: { description: "write", execute: writeExecute },
      read: { description: "read" },
    }));
    let wrappedTools: Record<string, { execute?: (...args: unknown[]) => unknown }> | null = null;
    const streamText = mock(async (args: { tools?: Record<string, unknown> }) => {
      wrappedTools = args.tools as typeof wrappedTools;
      return {
        text: "done",
        response: { messages: [{ role: "assistant", content: "done" }] },
      };
    });
    const runTurn = createRunTurn({
      streamText,
      stepCountIs: () => "step-count-sentinel",
      getModel: () => "model-sentinel",
      createTools,
      loadMCPServers: async () => [],
      loadMCPTools: async () => ({ tools: {}, errors: [] }),
    });

    await runTurn(makeParams({ assertCanMutate }));

    expect(streamText).toHaveBeenCalledTimes(1);
    expect(wrappedTools).not.toBeNull();
    expect(typeof wrappedTools?.write?.execute).toBe("function");
    // Tools without execute stay untouched.
    expect(wrappedTools?.read).toEqual({ description: "read" });

    await wrappedTools?.write?.execute?.({ path: "a.txt" }, { toolCallId: "call-1" });
    expect(assertCanMutate).toHaveBeenCalledWith("write");
    expect(writeExecute).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["gate:write", "execute:write"]);
  });

  test("blocks tool execute when assertCanMutate rejects", async () => {
    const writeExecute = mock(async () => ({ ok: true }));
    const createTools = mock(() => ({
      write: { description: "write", execute: writeExecute },
    }));
    let wrappedTools: Record<string, { execute?: (...args: unknown[]) => unknown }> | null = null;
    const streamText = mock(async (args: { tools?: Record<string, unknown> }) => {
      wrappedTools = args.tools as typeof wrappedTools;
      return {
        text: "done",
        response: { messages: [{ role: "assistant", content: "done" }] },
      };
    });
    const runTurn = createRunTurn({
      streamText,
      stepCountIs: () => "step-count-sentinel",
      getModel: () => "model-sentinel",
      createTools,
      loadMCPServers: async () => [],
      loadMCPTools: async () => ({ tools: {}, errors: [] }),
    });

    await runTurn(
      makeParams({
        assertCanMutate: async (toolName) => {
          throw new Error(`Tool ${toolName} blocked because the turn was cancelled.`);
        },
      }),
    );

    await expect(wrappedTools?.write?.execute?.({ path: "a.txt" })).rejects.toThrow(
      /blocked because the turn was cancelled/,
    );
    expect(writeExecute).not.toHaveBeenCalled();
  });
});
