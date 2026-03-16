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
});
