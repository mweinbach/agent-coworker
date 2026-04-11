import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import { createSpawnAgentTool } from "../src/tools/spawnAgent";
import type { ToolContext } from "../src/tools/context";
import type { PersistentAgentSummary } from "../src/shared/agents";
import type { AgentConfig } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/spawn-agent-tool";
  return {
    provider: "openai",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5-mini",
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
    ...overrides,
  };
}

function makeSummary(overrides: Partial<PersistentAgentSummary> = {}): PersistentAgentSummary {
  return {
    agentId: "child-1",
    parentSessionId: "root-1",
    role: "worker",
    mode: "collaborative",
    depth: 1,
    effectiveModel: "gpt-5-mini",
    title: "Investigate",
    provider: "openai",
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    lifecycleState: "active",
    executionState: "running",
    busy: true,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: makeConfig(),
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    ...overrides,
  };
}

describe("spawnAgent tool", () => {
  test("forwards message and optional fields to agentControl.spawn", async () => {
    const summary = makeSummary({
      role: "research",
      effectiveModel: "gpt-5.4",
      requestedModel: "gpt-5.4",
      requestedReasoningEffort: "high",
      effectiveReasoningEffort: "high",
    });
    const spawn = mock(async () => summary);
    const tool: any = createSpawnAgentTool(makeCtx({
      agentControl: {
        spawn,
        list: async () => [],
        sendInput: async () => {},
        wait: async () => ({ timedOut: false, agents: [] }),
        inspect: async () => ({
          agent: summary,
          latestAssistantText: null,
          parsedReport: null,
          sessionUsage: null,
          lastTurnUsage: null,
        }),
        resume: async () => summary,
        close: async () => summary,
      },
    }));

    const result = await tool.execute({
      message: "Investigate this failure",
      role: "research",
      model: "gpt-5.4",
      reasoningEffort: "high",
      forkContext: true,
    });

    expect(spawn).toHaveBeenCalledWith({
      message: "Investigate this failure",
      role: "research",
      model: "gpt-5.4",
      reasoningEffort: "high",
      forkContext: true,
    });
    expect(result).toEqual(summary);
  });

  test("defaults role to default", async () => {
    const summary = makeSummary({ role: "default" });
    const spawn = mock(async () => summary);
    const tool: any = createSpawnAgentTool(makeCtx({
      agentControl: {
        spawn,
        list: async () => [],
        sendInput: async () => {},
        wait: async () => ({ timedOut: false, agents: [] }),
        inspect: async () => ({
          agent: summary,
          latestAssistantText: null,
          parsedReport: null,
          sessionUsage: null,
          lastTurnUsage: null,
        }),
        resume: async () => summary,
        close: async () => summary,
      },
    }));

    await tool.execute({ message: "Check the code path" });

    expect(spawn).toHaveBeenCalledWith({
      message: "Check the code path",
      role: "default",
    });
  });

  test("rejects when no child-agent control is available", async () => {
    const tool: any = createSpawnAgentTool(makeCtx());
    await expect(tool.execute({ message: "Investigate" })).rejects.toThrow(
      "Child agents are unavailable outside a session-backed turn.",
    );
  });
});
