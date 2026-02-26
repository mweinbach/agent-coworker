import { describe, expect, mock, test } from "bun:test";

import { createSessionTitleGenerator, DEFAULT_SESSION_TITLE } from "../src/server/sessionTitleService";
import type { AgentConfig } from "../src/types";

function makeConfig(provider: AgentConfig["provider"] = "openai"): AgentConfig {
  return {
    provider,
    model: provider === "openai" ? "gpt-5.2" : "gemini-3-flash-preview",
    subAgentModel: provider === "openai" ? "gpt-5.2" : "gemini-3-flash-preview",
    workingDirectory: "/tmp/workspace",
    outputDirectory: "/tmp/workspace/output",
    uploadsDirectory: "/tmp/workspace/uploads",
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: "/tmp/workspace/.agent",
    userAgentDir: "/tmp/home/.agent",
    builtInDir: "/tmp/built-in",
    builtInConfigDir: "/tmp/built-in/config",
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

/** Build a mock AssistantMessage with text content. */
function mockAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai" as any,
    provider: "openai",
    model: "gpt-5-mini",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("sessionTitleService", () => {
  test("returns sanitized model title on first successful candidate", async () => {
    const completeSimple = mock(async (_model: any, _context: any, _opts?: any) =>
      mockAssistantMessage('  "Hello   World"  ')
    );
    const getModel = mock((_config: AgentConfig, modelId?: string) => ({ modelId }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      completeSimple: completeSimple as any,
      getModel: getModel as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({
      config: makeConfig("openai"),
      query: "please build websocket title persistence",
    });

    expect(result).toEqual({
      title: "Hello World",
      source: "model",
      model: "gpt-5-mini",
    });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(completeSimple.mock.calls[0]?.[2]?.maxTokens).toBe(150);
  });

  test("falls back to provider default model when primary model attempt fails", async () => {
    let callCount = 0;
    const completeSimple = mock(async (_model: any, _context: any, _opts?: any) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("primary unavailable");
      }
      return mockAssistantMessage("Fallback model title");
    });
    const getModel = mock((_config: AgentConfig, modelId?: string) => ({ modelId }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      completeSimple: completeSimple as any,
      getModel: getModel as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({
      config: makeConfig("openai"),
      query: "fallback path",
    });

    expect(result).toEqual({
      title: "Fallback model title",
      source: "model",
      model: "gpt-5.2",
    });
    expect(completeSimple).toHaveBeenCalledTimes(2);
  });

  test("falls back to deterministic heuristic when all model attempts fail", async () => {
    const completeSimple = mock(async (_model: any, _context: any, _opts?: any) => {
      throw new Error("all failed");
    });
    const getModel = mock((_config: AgentConfig, modelId?: string) => ({ modelId }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      completeSimple: completeSimple as any,
      getModel: getModel as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({
      config: makeConfig("openai"),
      query: "build a websocket title service with persistence and protocol updates for desktop and tui",
    });

    expect(result.source).toBe("heuristic");
    expect(result.model).toBeNull();
    expect(result.title.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(result.title.length).toBeLessThanOrEqual(53);
  });

  test("returns default title for empty queries", async () => {
    const completeSimple = mock(async (_model: any, _context: any, _opts?: any) =>
      mockAssistantMessage("unused")
    );
    const getModel = mock((_config: AgentConfig, modelId?: string) => ({ modelId }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      completeSimple: completeSimple as any,
      getModel: getModel as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({ config: makeConfig("openai"), query: "   " });
    expect(result).toEqual({ title: DEFAULT_SESSION_TITLE, source: "default", model: null });
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
