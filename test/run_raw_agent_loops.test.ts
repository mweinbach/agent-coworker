import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import {
  buildGoogleCustomtoolsToolCoverageRuns,
  buildMixedRuns,
  createRawLoopAgentControl,
} from "../scripts/run_raw_agent_loops";
import type { ModelMessage } from "../src/types";
import type { AgentConfig } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/raw-loop-agent-control";
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

describe("raw loop child-agent control", () => {
  test("supports spawnAgent handles plus waitForAgent completion", async () => {
    const run = mock(async () => "SUBAGENT_OK");
    const control = createRawLoopAgentControl(
      {
        config: makeConfig(),
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => true,
      },
      {
        createDelegateRunner: () => ({ run }),
        makeId: () => "child-1",
      },
    );

    const spawned = await control.spawn({
      role: "worker",
      message: "Reply with exactly SUBAGENT_OK",
    });
    const waited = await control.wait({
      agentIds: [spawned.agentId],
      timeoutMs: 1000,
    });

    expect(spawned.agentId).toBe("child-1");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        message: "Reply with exactly SUBAGENT_OK",
      }),
    );
    expect(waited).toEqual({
      timedOut: false,
      agents: [
        expect.objectContaining({
          agentId: "child-1",
          executionState: "completed",
          busy: false,
          lastMessagePreview: "SUBAGENT_OK",
        }),
      ],
    });
  });

  test("passes parent messages into delegate runs when forkContext is requested", async () => {
    const run = mock(async () => "SUBAGENT_OK");
    const parentMessages: ModelMessage[] = [
      { role: "user", content: "Root context" },
      { role: "assistant", content: "Current findings" },
    ];
    const control = createRawLoopAgentControl(
      {
        config: makeConfig(),
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => true,
        parentMessages,
      },
      {
        createDelegateRunner: () => ({ run }),
      },
    );

    await control.spawn({
      role: "worker",
      message: "Use the parent context",
      forkContext: true,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Use the parent context",
        seedMessages: parentMessages,
      }),
    );
  });
});

describe("raw loop scripted spawnAgent prompts", () => {
  test("use the current spawnAgent handle contract", () => {
    const gctRun = buildGoogleCustomtoolsToolCoverageRuns().find((run) => run.id === "gct-04-gapfill-edit-grep-spawn");
    const mixedRun = buildMixedRuns().find((run) => run.id === "run-08");
    expect(gctRun).toBeDefined();
    expect(mixedRun).toBeDefined();

    const gctPrompt = gctRun!.prompt({ runDir: "/tmp/raw-loop", repoDir: "/tmp/repo" });
    const mixedPrompt = mixedRun!.prompt({ runDir: "/tmp/raw-loop", repoDir: "/tmp/repo" });

    expect(gctRun!.requiredToolCalls).toEqual(expect.arrayContaining(["spawnAgent", "waitForAgent"]));
    expect(mixedRun!.requiredToolCalls).toEqual(expect.arrayContaining(["spawnAgent", "waitForAgent"]));

    expect(gctPrompt).toContain('role="worker" and message:');
    expect(gctPrompt).toContain("waitForAgent");
    expect(gctPrompt).toContain("lastMessagePreview");
    expect(gctPrompt).not.toContain('role="general"');
    expect(gctPrompt).not.toContain(" task:");
    expect(gctPrompt).not.toContain("spawnAgent result");

    expect(mixedPrompt).toContain('role="research" and message:');
    expect(mixedPrompt).toContain("waitForAgent");
    expect(mixedPrompt).toContain("lastMessagePreview JSON");
    expect(mixedPrompt).not.toContain(" task:");
  });
});
