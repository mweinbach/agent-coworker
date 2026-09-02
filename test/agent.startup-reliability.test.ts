import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import path from "node:path";

import { createRunTurn, type RunTurnParams } from "../src/agent";
import { closeMcpServersForSession } from "../src/mcp";
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

  test.each(["disabled", "empty", "cached"] as const)(
    "skips cleanup timers and listeners for %s MCP without a turn-owned close",
    async (mode) => {
      const close = mock(async () => {});
      const loadTools = mock(async () => ({ tools: {}, errors: [], close }));
      const controller = new AbortController();
      const schedule = spyOn(globalThis, "setTimeout");
      const addListener = spyOn(controller.signal, "addEventListener");
      const removeListener = spyOn(controller.signal, "removeEventListener");
      const result = { text: "done", responseMessages: [] };
      const sessionId = mode === "cached" ? "startup-no-owner-cached" : undefined;
      const runTurn = createRunTurn({
        createRuntime: () => ({
          name: "pi",
          runTurn: async () => {
            schedule.mockClear();
            addListener.mockClear();
            removeListener.mockClear();
            return result;
          },
        }),
        createTools: () => ({}),
        loadMCPServers: async () =>
          mode === "cached"
            ? [{ name: "test", transport: { type: "stdio", command: "unused", args: [] } }]
            : [],
        loadMCPTools: loadTools,
      });
      try {
        for (const _turn of [1, 2]) {
          expect(
            await runTurn(
              makeParams({
                enableMcp: mode !== "disabled",
                sessionId,
                abortSignal: controller.signal,
              }),
            ),
          ).toBe(result);
          expect(schedule).not.toHaveBeenCalled();
          expect(addListener).not.toHaveBeenCalled();
          expect(removeListener).not.toHaveBeenCalled();
          expect(close).not.toHaveBeenCalled();
        }
        expect(loadTools).toHaveBeenCalledTimes(mode === "cached" ? 1 : 0);
      } finally {
        schedule.mockRestore();
        addListener.mockRestore();
        removeListener.mockRestore();
        if (sessionId) await closeMcpServersForSession(sessionId);
      }
      expect(close).toHaveBeenCalledTimes(mode === "cached" ? 1 : 0);
    },
  );

  test.each(["result", "error"] as const)(
    "preserves the original %s and callbacks when abort arrives at no-owner settlement",
    async (outcome) => {
      const controller = new AbortController();
      const events: string[] = [];
      const result = { text: "done", responseMessages: [] };
      const error = new Error("Original model failure");
      const runTurn = createRunTurn({
        createTools: () => ({}),
        createRuntime: () => ({
          name: "pi",
          runTurn: async (params) => {
            await params.onModelStreamPart?.({ type: "text-delta", text: "done" });
            await params.onModelRawEvent?.({
              format: "openai-responses-v1",
              event: { type: "response.completed" },
            });
            events.push("model-settled");
            queueMicrotask(() => {
              controller.abort();
              events.push("aborted");
            });
            if (outcome === "error") throw error;
            return result;
          },
        }),
      });
      const operation = runTurn(
        makeParams({
          abortSignal: controller.signal,
          onModelStreamPart: () => {
            events.push("stream");
          },
          onModelRawEvent: () => {
            events.push("raw");
          },
        }),
      );
      if (outcome === "error") await expect(operation).rejects.toBe(error);
      else expect(await operation).toBe(result);
      events.push("turn-settled");
      expect(controller.signal.aborted).toBe(true);
      expect(events).toEqual(["stream", "raw", "model-settled", "aborted", "turn-settled"]);
    },
  );

  test.each(["abort", "startup failure"] as const)(
    "retains late MCP close ownership after %s while tools are loading",
    async (failure) => {
      const loadStarted = Promise.withResolvers<void>();
      const closeErrorLogged = Promise.withResolvers<void>();
      const close = mock(async () => {
        throw new Error("Late connector close failure");
      });
      const loaded = { tools: {}, errors: [] as string[], close };
      const pendingLoad = Promise.withResolvers<typeof loaded>();
      const controller = new AbortController();
      const startupError = new Error("Original startup failure");
      const runModel = mock(async () => ({ text: "unexpected", responseMessages: [] }));
      const runTurn = createRunTurn({
        createRuntime: () => ({ name: "pi", runTurn: runModel }),
        createTools: () => ({}),
        loadMCPServers: async () => [
          { name: "test", transport: { type: "stdio", command: "unused", args: [] } },
        ],
        loadMCPTools: async () => {
          loadStarted.resolve();
          return await pendingLoad.promise;
        },
      });
      if (failure === "startup failure") {
        observabilityRuntimeInternal.setEnsureObservabilityRuntimeForTests(async () => {
          await loadStarted.promise;
          throw startupError;
        });
      }
      const log = mock((line: string) => {
        if (line.includes("Late connector close failure")) closeErrorLogged.resolve();
      });
      const operation = runTurn(
        makeParams({ enableMcp: true, abortSignal: controller.signal, log }),
      );
      const settled = operation.then(
        (result) => ({ result, error: undefined }),
        (error: Error) => ({ result: undefined, error }),
      );
      try {
        await loadStarted.promise;
        if (failure === "abort") controller.abort();
        const outcome = await settled;
        expect(outcome.result).toBeUndefined();
        if (failure === "abort") expect(outcome.error?.message).toBe("Model turn aborted.");
        else expect(outcome.error).toBe(startupError);
        expect(close).not.toHaveBeenCalled();
        expect(runModel).not.toHaveBeenCalled();
      } finally {
        pendingLoad.resolve(loaded);
        await settled;
      }
      await closeErrorLogged.promise;
      expect(close).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[MCP] Error closing MCP connections: Error: Late connector close failure",
      );
    },
  );

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
