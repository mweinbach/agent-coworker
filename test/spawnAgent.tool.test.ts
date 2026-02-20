import { describe, expect, test, mock, beforeEach } from "bun:test";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../src/types";
import type { ToolContext } from "../src/tools/context";

import { createSpawnAgentTool } from "../src/tools/spawnAgent";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(dir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "google",
    model: "model-main",
    subAgentModel: "model-sub",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: process.cwd(),
    builtInConfigDir: path.join(process.cwd(), "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function makeCtx(dir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: makeConfig(dir),
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawnAgent tool", () => {
  let lastGenerateTextArgs: any = null;

  const mockStreamText = mock(async (args: any) => {
    lastGenerateTextArgs = args;
    return { text: "subagent result" };
  });

  const mockStepCountIs = mock((n: number) => `stepCountIs:${n}`);
  const mockGetModel = mock((_config: AgentConfig, id?: string) => ({ modelId: id ?? "" }));
  const mockLoadSubAgentPrompt = mock(async (_config: AgentConfig, agentType: string) => `SYSTEM:${agentType}`);
  const mockClassifyCommandDetailed = mock((command: string) => {
    if (command === "pwd") return { kind: "auto" as const };
    return {
      kind: "prompt" as const,
      dangerous: false as const,
      riskCode: "requires_manual_review" as const,
    };
  });

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();

    lastGenerateTextArgs = null;
    mockStreamText.mockClear();
    mockStepCountIs.mockClear();
    mockGetModel.mockClear();
    mockLoadSubAgentPrompt.mockClear();
    mockClassifyCommandDetailed.mockClear();
  });

  test("general uses subAgentModel and general tool set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-agent-general-"));
    const ctx = makeCtx(dir, {
      config: makeConfig(dir, { providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } } }),
    });

    const t: any = createSpawnAgentTool(ctx, {
      streamText: mockStreamText as any,
      stepCountIs: mockStepCountIs as any,
      getModel: mockGetModel as any,
      loadSubAgentPrompt: mockLoadSubAgentPrompt as any,
      classifyCommandDetailed: mockClassifyCommandDetailed as any,
    });

    const out = await t.execute({ task: "do the thing", agentType: "general" });

    expect(out).toBe("subagent result");
    expect(mockLoadSubAgentPrompt).toHaveBeenCalledWith(ctx.config, "general");
    expect(mockGetModel).toHaveBeenCalledWith(ctx.config, "model-sub");
    expect(mockStepCountIs).toHaveBeenCalledWith(50);

    expect(lastGenerateTextArgs.system).toBe("SYSTEM:general");
    expect(lastGenerateTextArgs.prompt).toBe("do the thing");
    expect(lastGenerateTextArgs.stopWhen).toBe("stepCountIs:50");
    expect(lastGenerateTextArgs.providerOptions).toEqual(ctx.config.providerOptions);
    expect(lastGenerateTextArgs.timeout).toBeUndefined();

    const toolNames = Object.keys(lastGenerateTextArgs.tools).sort();
    expect(toolNames).toEqual(
      ["edit", "glob", "grep", "memory", "notebookEdit", "read", "skill", "webFetch", "webSearch", "write"].sort()
    );
    expect(lastGenerateTextArgs.tools.webSearch.type).toBeUndefined();
    expect(typeof lastGenerateTextArgs.tools.webSearch.execute).toBe("function");
  });

  test("adds google prepareStep to repair replay thought signatures in sub-agent loops", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-agent-prepare-step-"));
    const log = mock(() => {});
    const ctx = makeCtx(dir, {
      log,
      config: makeConfig(dir, {
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: "high",
            },
          },
        },
      }),
    });

    const t: any = createSpawnAgentTool(ctx, {
      streamText: mockStreamText as any,
      stepCountIs: mockStepCountIs as any,
      getModel: mockGetModel as any,
      loadSubAgentPrompt: mockLoadSubAgentPrompt as any,
      classifyCommandDetailed: mockClassifyCommandDetailed as any,
    });

    await t.execute({ task: "loop-safe sub-agent", agentType: "general" });

    expect(typeof lastGenerateTextArgs.prepareStep).toBe("function");
    const replayMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: { google: { thoughtSignature: "sig-sub" } },
          },
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[];

    const repaired = await lastGenerateTextArgs.prepareStep({ stepNumber: 1, messages: replayMessages });
    expect(repaired).toBeDefined();
    expect(repaired.providerOptions).toBeUndefined();
    expect(JSON.stringify(repaired.messages)).toContain("\"thoughtSignature\":\"sig-sub\"");

    const unresolved = await lastGenerateTextArgs.prepareStep({
      stepNumber: 1,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call-2", toolName: "bash", input: { command: "pwd" } }],
        },
      ],
    });
    expect(unresolved).toBeDefined();
    expect(unresolved.providerOptions.google.thinkingConfig.includeThoughts).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disabling thoughts for this step"));
  });

  test("research uses main model and web-only tool set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-agent-research-"));
    const ctx = makeCtx(dir);

    const t: any = createSpawnAgentTool(ctx, {
      streamText: mockStreamText as any,
      stepCountIs: mockStepCountIs as any,
      getModel: mockGetModel as any,
      loadSubAgentPrompt: mockLoadSubAgentPrompt as any,
      classifyCommandDetailed: mockClassifyCommandDetailed as any,
    });

    await t.execute({ task: "research it", agentType: "research" });

    expect(mockLoadSubAgentPrompt).toHaveBeenCalledWith(ctx.config, "research");
    expect(mockGetModel).toHaveBeenCalledWith(ctx.config, "model-main");

    const toolNames = Object.keys(lastGenerateTextArgs.tools).sort();
    expect(toolNames).toEqual(["read", "webFetch", "webSearch"].sort());
    expect(lastGenerateTextArgs.tools.webSearch.type).toBeUndefined();
    expect(typeof lastGenerateTextArgs.tools.webSearch.execute).toBe("function");
  });

  test("explore includes bash tool and escalates non-auto approvals to parent context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-agent-explore-"));
    const parentApprove = mock(async (command: string) => !command.includes("touch"));
    const ctx = makeCtx(dir, { approveCommand: parentApprove });

    const t: any = createSpawnAgentTool(ctx, {
      streamText: mockStreamText as any,
      stepCountIs: mockStepCountIs as any,
      getModel: mockGetModel as any,
      loadSubAgentPrompt: mockLoadSubAgentPrompt as any,
      classifyCommandDetailed: mockClassifyCommandDetailed as any,
    });

    await t.execute({ task: "explore it", agentType: "explore" });

    const tools = lastGenerateTextArgs.tools as Record<string, any>;
    expect(Object.keys(tools).sort()).toEqual(["bash", "glob", "grep", "read"].sort());

    const ok = await tools.bash.execute({ command: "pwd" });
    expect(ok.exitCode).toBe(0);

    const rejected = await tools.bash.execute({ command: "touch /tmp/should-not-run" });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("rejected");
    expect(parentApprove).toHaveBeenCalledWith("touch /tmp/should-not-run");
  });

  test("forwards abortSignal to sub-agent streamText call", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-agent-abort-"));
    const controller = new AbortController();
    const ctx = makeCtx(dir, { abortSignal: controller.signal });

    const t: any = createSpawnAgentTool(ctx, {
      streamText: mockStreamText as any,
      stepCountIs: mockStepCountIs as any,
      getModel: mockGetModel as any,
      loadSubAgentPrompt: mockLoadSubAgentPrompt as any,
      classifyCommandDetailed: mockClassifyCommandDetailed as any,
    });

    await t.execute({ task: "check signal", agentType: "general" });
    expect(lastGenerateTextArgs.abortSignal).toBe(controller.signal);
  });

  test("enables AI SDK telemetry with full I/O when observability is configured", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-agent-telemetry-"));
    const ctx = makeCtx(dir, {
      config: makeConfig(dir, {
        observabilityEnabled: true,
        observability: {
          provider: "langfuse",
          baseUrl: "https://cloud.langfuse.com",
          otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
          publicKey: "pk-lf-test",
          secretKey: "sk-lf-test",
        },
      }),
    });

    const t: any = createSpawnAgentTool(ctx, {
      streamText: mockStreamText as any,
      stepCountIs: mockStepCountIs as any,
      getModel: mockGetModel as any,
      loadSubAgentPrompt: mockLoadSubAgentPrompt as any,
      classifyCommandDetailed: mockClassifyCommandDetailed as any,
    });

    await t.execute({ task: "telemetry check", agentType: "general" });

    expect(lastGenerateTextArgs.experimental_telemetry).toBeDefined();
    expect(lastGenerateTextArgs.experimental_telemetry.isEnabled).toBe(true);
    expect(lastGenerateTextArgs.experimental_telemetry.recordInputs).toBe(true);
    expect(lastGenerateTextArgs.experimental_telemetry.recordOutputs).toBe(true);
    expect(lastGenerateTextArgs.experimental_telemetry.functionId).toBe("tool.spawnAgent");
  });

  test("rejects sub-agent recursion beyond configured depth", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-agent-depth-"));
    const ctx = makeCtx(dir, { spawnDepth: 2 });

    const t: any = createSpawnAgentTool(ctx, {
      streamText: mockStreamText as any,
      stepCountIs: mockStepCountIs as any,
      getModel: mockGetModel as any,
      loadSubAgentPrompt: mockLoadSubAgentPrompt as any,
      classifyCommandDetailed: mockClassifyCommandDetailed as any,
    });

    await expect(t.execute({ task: "any task", agentType: "general" })).rejects.toThrow(
      /recursion depth exceeded/i
    );
  });
});
