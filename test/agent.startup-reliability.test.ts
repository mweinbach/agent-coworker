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

  test("closes turn-owned MCP connections when tool construction fails", async () => {
    const close = mock(async () => {});
    const runTurn = createRunTurn({
      createTools: () => {
        throw new Error("Tool construction failed");
      },
      loadMCPServers: async () => [
        { name: "test", transport: { type: "stdio", command: "unused", args: [] } },
      ],
      loadMCPTools: async () => ({ tools: {}, errors: [], close }),
    });

    await expect(runTurn(makeParams({ enableMcp: true }))).rejects.toThrow(
      "Tool construction failed",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("closes turn-owned MCP connections when the load-error callback fails", async () => {
    const close = mock(async () => {});
    const runTurn = createRunTurn({
      createTools: () => ({}),
      loadMCPServers: async () => [
        { name: "test", transport: { type: "stdio", command: "unused", args: [] } },
      ],
      loadMCPTools: async () => ({ tools: {}, errors: ["Connector unavailable"], close }),
    });

    await expect(
      runTurn(
        makeParams({
          enableMcp: true,
          onMcpLoadErrors: () => {
            throw new Error("Load-error callback failed");
          },
        }),
      ),
    ).rejects.toThrow("Load-error callback failed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test.each(["before cleanup", "during cleanup"] as const)(
    "Stop %s interrupts a stalled MCP close without losing late errors",
    async (phase) => {
      const cleanupStarted = Promise.withResolvers<void>();
      const cleanupFinished = Promise.withResolvers<void>();
      const cleanupErrorLogged = Promise.withResolvers<void>();
      const logLines: string[] = [];
      const close = mock(async () => {
        cleanupStarted.resolve();
        await cleanupFinished.promise;
        throw new Error("Late cleanup failure");
      });
      const controller = new AbortController();
      const runTurn = createRunTurn({
        createRuntime: () => ({
          name: "pi",
          runTurn: async () => {
            if (phase === "before cleanup") controller.abort();
            throw new Error("Model turn aborted.");
          },
        }),
        createTools: () => ({}),
        loadMCPServers: async () => [
          { name: "test", transport: { type: "stdio", command: "unused", args: [] } },
        ],
        loadMCPTools: async () => ({ tools: {}, errors: [], close }),
      });
      const operation = runTurn(
        makeParams({
          enableMcp: true,
          abortSignal: controller.signal,
          log: (line) => {
            logLines.push(line);
            if (line.includes("Late cleanup failure")) cleanupErrorLogged.resolve();
          },
        }),
      );
      const settled = operation.then(
        () => ({ kind: "completed" as const }),
        (error: Error) => ({ kind: "rejected" as const, error }),
      );
      await cleanupStarted.promise;
      controller.abort();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          settled,
          new Promise<{ kind: "hung" }>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: "hung" }), 500);
          }),
        ]);
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind === "rejected") expect(outcome.error.message).toBe("Model turn aborted.");
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        cleanupFinished.resolve();
        await settled;
      }
      await cleanupErrorLogged.promise;
      expect(close).toHaveBeenCalledTimes(1);
      expect(logLines.some((line) => line.includes("Late cleanup failure"))).toBe(true);
    },
  );

  test("bounds MCP cleanup waits after a successful turn", async () => {
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanupFinished = Promise.withResolvers<void>();
    const close = mock(async () => {
      cleanupStarted.resolve();
      await cleanupFinished.promise;
    });
    const runTurn = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async () => ({ text: "done", responseMessages: [] }),
      }),
      createTools: () => ({}),
      loadMCPServers: async () => [
        { name: "test", transport: { type: "stdio", command: "unused", args: [] } },
      ],
      loadMCPTools: async () => ({ tools: {}, errors: [], close }),
    });
    const operation = runTurn(makeParams({ enableMcp: true }));
    const settled = operation.then((result) => ({ kind: "completed" as const, result }));
    await cleanupStarted.promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        settled,
        new Promise<{ kind: "hung" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "hung" }), 750);
        }),
      ]);
      expect(outcome.kind).toBe("completed");
      if (outcome.kind === "completed") expect(outcome.result.text).toBe("done");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      cleanupFinished.resolve();
      await settled;
    }
    expect(close).toHaveBeenCalledTimes(1);
  });
});
