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

function makeDelegateRunResult(text: string) {
  return {
    text,
    responseMessages: [{ role: "assistant", content: text }] as ModelMessage[],
  };
}

describe("raw loop child-agent control", () => {
  test("uses connected providers for cross-provider child routing", async () => {
    const run = mock(async () => makeDelegateRunResult("SUBAGENT_OK"));
    const control = createRawLoopAgentControl(
      {
        config: makeConfig({
          provider: "codex-cli",
          model: "gpt-5.4",
          preferredChildModel: "gpt-5.4",
          childModelRoutingMode: "cross-provider-allowlist",
          preferredChildModelRef: "codex-cli:gpt-5.4",
          allowedChildModelRefs: ["opencode-zen:glm-5"],
        }),
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => true,
      },
      {
        createDelegateRunner: () => ({ run }),
        getConnectedProviders: async () => ["codex-cli", "opencode-zen"],
      },
    );

    const spawned = await control.spawn({
      role: "worker",
      model: "opencode-zen:glm-5",
      message: "Use the child model",
    });
    await control.wait({
      agentIds: [spawned.agentId],
      timeoutMs: 1000,
    });

    expect(spawned).toEqual(expect.objectContaining({
      provider: "opencode-zen",
      effectiveModel: "glm-5",
    }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        message: "Use the child model",
        connectedProviders: ["codex-cli", "opencode-zen"],
        config: expect.objectContaining({
          provider: "opencode-zen",
          model: "glm-5",
        }),
      }),
    );
  });

  test("falls back when requested cross-provider child ref is not connected", async () => {
    const run = mock(async () => makeDelegateRunResult("SUBAGENT_OK"));
    const control = createRawLoopAgentControl(
      {
        config: makeConfig({
          provider: "codex-cli",
          model: "gpt-5.4",
          preferredChildModel: "gpt-5.4",
          childModelRoutingMode: "cross-provider-allowlist",
          preferredChildModelRef: "codex-cli:gpt-5.4",
          allowedChildModelRefs: ["opencode-zen:glm-5"],
        }),
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => true,
      },
      {
        createDelegateRunner: () => ({ run }),
        getConnectedProviders: async () => ["codex-cli"],
      },
    );

    const spawned = await control.spawn({
      role: "worker",
      model: "opencode-zen:glm-5",
      message: "Fallback to parent provider",
    });
    await control.wait({
      agentIds: [spawned.agentId],
      timeoutMs: 1000,
    });

    expect(spawned).toEqual(expect.objectContaining({
      provider: "codex-cli",
      effectiveModel: "gpt-5.4",
    }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          provider: "codex-cli",
          model: "gpt-5.4",
        }),
        connectedProviders: ["codex-cli"],
      }),
    );
  });

  test("supports spawnAgent handles plus waitForAgent completion", async () => {
    const run = mock(async () => makeDelegateRunResult("SUBAGENT_OK"));
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
    const run = mock(async () => makeDelegateRunResult("SUBAGENT_OK"));
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

  test("carries child history into subsequent sendInput runs", async () => {
    const run = mock()
      .mockResolvedValueOnce(makeDelegateRunResult("First reply"))
      .mockResolvedValueOnce(makeDelegateRunResult("Second reply"));
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
      message: "First task",
    });
    await control.wait({
      agentIds: [spawned.agentId],
      timeoutMs: 1000,
    });

    await control.sendInput({
      agentId: spawned.agentId,
      message: "Second task",
    });
    await control.wait({
      agentIds: [spawned.agentId],
      timeoutMs: 1000,
    });

    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: "Second task",
        seedMessages: [
          { role: "user", content: "First task" },
          { role: "assistant", content: "First reply" },
        ],
      }),
    );
  });

  test("reopens a closed child summary on resume", async () => {
    const run = mock(async () => makeDelegateRunResult("SUBAGENT_OK"));
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
    await control.wait({
      agentIds: [spawned.agentId],
      timeoutMs: 1000,
    });

    const closed = await control.close({
      agentId: spawned.agentId,
    });
    expect(closed).toEqual(
      expect.objectContaining({
        agentId: "child-1",
        lifecycleState: "closed",
        executionState: "closed",
      }),
    );

    const resumed = await control.resume({
      agentId: spawned.agentId,
    });
    expect(resumed).toEqual(
      expect.objectContaining({
        agentId: "child-1",
        lifecycleState: "active",
        executionState: "completed",
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
