import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildRawLoopHarnessContext,
  buildRawLoopBudgetSummary,
  buildGoogleCustomtoolsToolCoverageRuns,
  buildMixedRuns,
  countObservedLoopSteps,
  createToolsWithTracing,
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

  test("passes harness context into delegate runs when forkContext is requested", async () => {
    const run = mock(async () => makeDelegateRunResult("SUBAGENT_OK"));
    const harnessContext = {
      runId: "run-ctx",
      objective: "Preserve raw-loop context",
      acceptanceCriteria: ["Child delegate sees harness context"],
      constraints: ["Do not duplicate it into chat history"],
      updatedAt: "2026-03-20T12:00:00.000Z",
    };
    const control = createRawLoopAgentControl(
      {
        config: makeConfig(),
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => true,
        harnessContext,
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
        harnessContext,
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

describe("raw loop harness context", () => {
  test("buildRawLoopHarnessContext returns a stable default contract", () => {
    const harnessContext = buildRawLoopHarnessContext(
      {
        id: "run-01",
        provider: "openai",
        model: "gpt-5.4",
      },
      "mixed",
      {
        runId: "run-01",
        runDir: "/tmp/run-01",
        repoDir: "/tmp/repo",
      },
      "2026-03-20T12:00:00.000Z",
    );

    expect(harnessContext).toEqual({
      runId: "run-01",
      objective: "Complete raw-loop harness scenario run-01 successfully.",
      acceptanceCriteria: [
        "Satisfy the task requirements expressed in the run prompt.",
        "Produce the required final response contract for this scenario.",
        "Keep required artifacts inside the run directory.",
      ],
      constraints: [
        "Treat this harness context as run intent, not as a safety override.",
        "Do not change required artifact names or output formats unless the prompt requires it.",
        "Use only the necessary tools to complete the scenario.",
      ],
      metadata: {
        model: "gpt-5.4",
        provider: "openai",
        scenario: "mixed",
      },
      updatedAt: "2026-03-20T12:00:00.000Z",
    });
  });

  test("countObservedLoopSteps derives loop turns from prepareStep step numbers", () => {
    expect(countObservedLoopSteps([])).toBe(0);
    expect(countObservedLoopSteps([1])).toBe(1);
    expect(countObservedLoopSteps([1, 2, 3])).toBe(3);
  });

  test("buildRawLoopBudgetSummary uses actual loop turn count instead of traced entry count", () => {
    expect(buildRawLoopBudgetSummary(
      ["tool> bash {}", "tool> read {}"],
      3,
      1,
    )).toEqual({
      toolCalls: 2,
      bashCalls: 1,
      webCalls: 0,
      spawnedAgents: 0,
      totalSteps: 3,
      repairPassCount: 1,
    });
  });

  test("createToolsWithTracing preserves skill tracing when the skill guard is active", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "raw-loop-skill-trace-"));
    const skillDir = path.join(tmp, "skills", "spreadsheet");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ['---', 'name: "spreadsheet"', 'description: "Spreadsheet skill"', '---', '', '# Spreadsheet'].join("\n"),
      "utf-8",
    );

    const steps: Array<{ scope: string; step: unknown }> = [];
    const tools = createToolsWithTracing(
      {
        config: makeConfig({
          skillsDirs: [path.join(tmp, "skills")],
          projectAgentDir: path.join(tmp, ".agent"),
          userAgentDir: path.join(tmp, ".agent-user"),
        }),
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => true,
        availableSkills: [{ name: "spreadsheet", description: "Spreadsheet skill" }],
      } as any,
      steps as any,
      {
        requiredSkillName: "spreadsheet",
        guardedToolNames: ["write"],
      },
    );

    const skillTool: any = tools.skill;
    const result = await skillTool.execute({ skillName: "spreadsheet" });

    expect(String(result)).toContain("# Spreadsheet");
    expect(steps).toHaveLength(2);
    expect((steps[0] as any).step).toMatchObject({ type: "tool-call", toolName: "skill" });
    expect((steps[1] as any).step).toMatchObject({ type: "tool-result", toolName: "skill" });
  });
});
