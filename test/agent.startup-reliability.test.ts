import { afterEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

import { createRunTurn, type RunTurnParams } from "../src/agent";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";
import type { AgentConfig } from "../src/types";

function makeConfig(): AgentConfig {
  const workspace = "/tmp/agent-startup-reliability";
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: workspace,
    outputDirectory: path.join(workspace, "output"),
    uploadsDirectory: path.join(workspace, "uploads"),
    userName: "tester",
    knowledgeCutoff: "2025-01",
    projectCoworkDir: path.join(workspace, ".cowork"),
    userCoworkDir: path.join(workspace, ".cowork-user"),
    builtInDir: workspace,
    builtInConfigDir: path.join(workspace, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    observabilityEnabled: false,
  };
}

function makeParams(overrides: Partial<RunTurnParams> = {}): RunTurnParams {
  return {
    config: makeConfig(),
    system: "Be helpful.",
    messages: [{ role: "user", content: "hello" }],
    toolEnv: { COWORK_DISABLE_RUNTIME: "1" },
    log: () => {},
    askUser: async () => "yes",
    approveCommand: async () => true,
    ...overrides,
  };
}

describe("agent turn startup reliability", () => {
  afterEach(async () => {
    await observabilityRuntimeInternal.resetForTests();
  });

  test("does not start provider or MCP work for an already cancelled turn", async () => {
    const loadMcpServers = mock(async () => []);
    const runModel = mock(async () => ({ text: "unexpected", responseMessages: [] }));
    const runTurn = createRunTurn({
      createRuntime: () => ({ name: "pi", runTurn: runModel }),
      createTools: () => ({}),
      loadMCPServers: loadMcpServers,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runTurn(makeParams({ enableMcp: true, abortSignal: controller.signal })),
    ).rejects.toThrow("Model turn aborted.");
    expect(loadMcpServers).not.toHaveBeenCalled();
    expect(runModel).not.toHaveBeenCalled();
  });

  test("Stop immediately cancels cold startup while an MCP connector is stalled", async () => {
    const pendingServers = Promise.withResolvers<[]>();
    const runModel = mock(async () => ({ text: "unexpected", responseMessages: [] }));
    const runTurn = createRunTurn({
      createRuntime: () => ({ name: "pi", runTurn: runModel }),
      createTools: () => ({}),
      loadMCPServers: async () => await pendingServers.promise,
    });
    const controller = new AbortController();
    const operation = runTurn(makeParams({ enableMcp: true, abortSignal: controller.signal }));
    const settled = operation.then(
      () => ({ kind: "completed" as const }),
      (error: Error) => ({ kind: "rejected" as const, error }),
    );

    controller.abort();
    const outcome = await Promise.race([
      settled,
      new Promise<{ kind: "hung" }>((resolve) => setTimeout(() => resolve({ kind: "hung" }), 100)),
    ]);

    pendingServers.resolve([]);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error.message).toBe("Model turn aborted.");
    }
    expect(runModel).not.toHaveBeenCalled();
  });

  test("a failed startup sibling never waits forever for a stalled MCP connector", async () => {
    const pendingServers = Promise.withResolvers<[]>();
    const runTurn = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async () => ({ text: "unexpected", responseMessages: [] }),
      }),
      createTools: () => ({}),
      loadMCPServers: async () => await pendingServers.promise,
    });
    observabilityRuntimeInternal.setEnsureObservabilityRuntimeForTests(async () => {
      throw new Error("observability startup failed");
    });

    const operation = runTurn(makeParams({ enableMcp: true }));
    const settled = operation.then(
      () => ({ kind: "completed" as const }),
      (error: Error) => ({ kind: "rejected" as const, error }),
    );
    const outcome = await Promise.race([
      settled,
      new Promise<{ kind: "hung" }>((resolve) => setTimeout(() => resolve({ kind: "hung" }), 500)),
    ]);

    pendingServers.resolve([]);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error.message).toBe("observability startup failed");
    }
  });
});
