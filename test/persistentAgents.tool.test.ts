import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import {
  createCloseAgentTool,
  createInspectAgentTool,
  createListAgentsTool,
  createResumeAgentTool,
  createSendAgentInputTool,
  createWaitForAgentTool,
} from "../src/tools/persistentAgents";
import type { ToolContext } from "../src/tools/context";
import type { PersistentAgentSummary } from "../src/shared/agents";
import type { AgentConfig } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/agent-tools";
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
    title: "Child",
    provider: "openai",
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    lifecycleState: "active",
    executionState: "completed",
    busy: false,
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

describe("persistent agent tools", () => {
  test("list/send/wait/resume/close forward to session-backed controls", async () => {
    const listed = [makeSummary()];
    const resumed = makeSummary({ executionState: "running", busy: true });
    const closed = makeSummary({ lifecycleState: "closed", executionState: "closed", busy: false });

    const list = mock(async () => listed);
    const sendInput = mock(async () => {});
    const wait = mock(async () => ({
      timedOut: false,
      agents: [makeSummary({ executionState: "completed" })],
    }));
    const inspect = mock(async () => ({
      agent: makeSummary({ executionState: "completed", lastMessagePreview: "done" }),
      latestAssistantText: "done",
      parsedReport: {
        status: "completed" as const,
        summary: "Finished",
      },
      sessionUsage: null,
      lastTurnUsage: null,
    }));
    const resume = mock(async () => resumed);
    const close = mock(async () => closed);

    const ctx = makeCtx({
      agentControl: {
        spawn: async () => makeSummary(),
        list,
        sendInput,
        wait,
        inspect,
        resume,
        close,
      },
    });

    const listTool: any = createListAgentsTool(ctx);
    const sendTool: any = createSendAgentInputTool(ctx);
    const waitTool: any = createWaitForAgentTool(ctx);
    const inspectTool: any = createInspectAgentTool(ctx);
    const resumeTool: any = createResumeAgentTool(ctx);
    const closeTool: any = createCloseAgentTool(ctx);

    expect(await listTool.execute({})).toEqual(listed);
    await expect(sendTool.execute({ agentId: "child-1", message: "next step", interrupt: true })).resolves.toEqual({
      agentId: "child-1",
      queued: true,
    });
    await expect(waitTool.execute({ agentIds: ["child-1"], timeoutMs: 10 })).resolves.toEqual({
      timedOut: false,
      agents: [makeSummary({ executionState: "completed" })],
    });
    await expect(inspectTool.execute({ agentId: "child-1" })).resolves.toEqual(expect.objectContaining({
      agent: expect.objectContaining({ agentId: "child-1" }),
      latestAssistantText: "done",
      parsedReport: expect.objectContaining({ status: "completed", summary: "Finished" }),
    }));
    await expect(resumeTool.execute({ agentId: "child-1" })).resolves.toEqual(resumed);
    await expect(closeTool.execute({ agentId: "child-1" })).resolves.toEqual(closed);

    expect(sendInput).toHaveBeenCalledWith({ agentId: "child-1", message: "next step", interrupt: true });
    expect(wait).toHaveBeenCalledWith({ agentIds: ["child-1"], timeoutMs: 10 });
    expect(inspect).toHaveBeenCalledWith({ agentId: "child-1" });
    expect(resume).toHaveBeenCalledWith({ agentId: "child-1" });
    expect(close).toHaveBeenCalledWith({ agentId: "child-1" });
  });

  test("tools reject calls when no agent control is available", async () => {
    const tool: any = createListAgentsTool(makeCtx());
    await expect(tool.execute({})).rejects.toThrow(
      "Child agents are unavailable outside a session-backed turn.",
    );
  });
});
