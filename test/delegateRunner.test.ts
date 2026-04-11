import { describe, expect, mock, test } from "bun:test";

import type { AgentConfig, ProviderName } from "../src/types";
import { DelegateRunner } from "../src/server/agents/DelegateRunner";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/delegate-runner";
  return {
    provider: "codex-cli",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5.4",
    workingDirectory: dir,
    outputDirectory: `${dir}/output`,
    uploadsDirectory: `${dir}/uploads`,
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: `${dir}/.agent`,
    userAgentDir: `${dir}/.agent-user`,
    builtInDir: dir,
    builtInConfigDir: `${dir}/config`,
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    childModelRoutingMode: "cross-provider-allowlist",
    preferredChildModelRef: "codex-cli:gpt-5.4",
    allowedChildModelRefs: ["opencode-zen:glm-5"],
    ...overrides,
  };
}

describe("DelegateRunner", () => {
  test("supports connectedProviders for cross-provider child routing", async () => {
    const runTurn = mock(async () => ({
      text: "ok",
      reasoningText: undefined as string | undefined,
      responseMessages: [],
    }));
    const createRuntime = mock(() => ({ runTurn }));
    const createTools = mock(() => ({
      read: { type: "builtin" },
    }));
    const runner = new DelegateRunner({
      loadAgentPrompt: async () => "delegate system prompt",
      buildRuntimeTelemetrySettings: async () => null,
      buildGooglePrepareStep: () => undefined,
      createRuntime,
      createTools,
    });

    await runner.run({
      config: makeConfig(),
      role: "worker",
      message: "Run with a cross-provider target",
      askUser: async () => "",
      approveCommand: async () => true,
      log: () => {},
      model: "opencode-zen:glm-5",
      connectedProviders: ["codex-cli", "opencode-zen"] as readonly ProviderName[],
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode-zen",
        model: "glm-5",
      }),
    );
    expect(createTools).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          read: expect.objectContaining({ type: "builtin" }),
        }),
      }),
    );
  });

  test("falls back to parent when cross-provider target is disconnected", async () => {
    const runTurn = mock(async () => ({
      text: "ok",
      reasoningText: undefined as string | undefined,
      responseMessages: [],
    }));
    const createRuntime = mock(() => ({ runTurn }));
    const runner = new DelegateRunner({
      loadAgentPrompt: async () => "delegate system prompt",
      buildRuntimeTelemetrySettings: async () => null,
      buildGooglePrepareStep: () => undefined,
      createRuntime,
      createTools: () => ({}),
    });

    await runner.run({
      config: makeConfig(),
      role: "worker",
      message: "Run fallback target",
      askUser: async () => "",
      approveCommand: async () => true,
      log: () => {},
      model: "opencode-zen:glm-5",
      connectedProviders: ["codex-cli"] as readonly ProviderName[],
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex-cli",
        model: "gpt-5.4",
      }),
    );
  });

  test("injects harness context into delegated child system prompts", async () => {
    const runTurn = mock(async () => ({
      text: "ok",
      reasoningText: undefined as string | undefined,
      responseMessages: [],
    }));
    const createRuntime = mock(() => ({ runTurn }));
    const runner = new DelegateRunner({
      loadAgentPrompt: async () => "delegate system prompt",
      buildRuntimeTelemetrySettings: async () => null,
      buildGooglePrepareStep: () => undefined,
      createRuntime,
      createTools: () => ({}),
    });

    await runner.run({
      config: makeConfig(),
      role: "worker",
      message: "Run with explicit harness context",
      askUser: async () => "",
      approveCommand: async () => true,
      log: () => {},
      harnessContext: {
        runId: "run-delegate",
        objective: "Verify delegated prompt injection",
        acceptanceCriteria: ["Child prompt contains harness context"],
        constraints: ["Do not override safety policy"],
        updatedAt: "2026-03-20T12:00:00.000Z",
      },
    });

    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("## Active Harness Context"),
      }),
    );
    expect(runTurn.mock.calls[0]?.[0]?.system).toContain("- Run ID: run-delegate");
    expect(runTurn.mock.calls[0]?.[0]?.system).toContain("- Objective: Verify delegated prompt injection");
  });

  test("seeds delegated todo state before the child turn starts", async () => {
    const seededTodos = [
      { content: "Carry parent plan", status: "in_progress", activeForm: "Carrying parent plan" },
    ];
    const updateTodos = mock((_todos: typeof seededTodos) => {});
    const runTurn = mock(async () => ({
      text: "ok",
      reasoningText: undefined as string | undefined,
      responseMessages: [],
    }));
    const runner = new DelegateRunner({
      loadAgentPrompt: async () => "delegate system prompt",
      buildRuntimeTelemetrySettings: async () => null,
      buildGooglePrepareStep: () => undefined,
      createRuntime: () => ({ runTurn }),
      createTools: () => ({}),
    });

    await runner.run({
      config: makeConfig(),
      role: "worker",
      message: "Continue the inherited plan",
      askUser: async () => "",
      approveCommand: async () => true,
      log: () => {},
      initialTodos: seededTodos,
      updateTodos,
    });

    expect(updateTodos).toHaveBeenCalledWith(seededTodos);
    expect(updateTodos.mock.invocationCallOrder[0]).toBeLessThan(runTurn.mock.invocationCallOrder[0]);
  });
});
