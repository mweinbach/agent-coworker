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

describe("sessionTitleService", () => {
  test("returns sanitized model title on first successful candidate", async () => {
    const generateObject = mock(async (_args: any) => ({ object: { title: '  "Hello   World"  ' } }));
    const getModel = mock((_config: AgentConfig, modelId?: string) => ({ modelId }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      generateObject: generateObject as any,
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
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateObject.mock.calls[0]?.[0]?.maxOutputTokens).toBe(150);
  });

  test("falls back to provider default model when primary model attempt fails", async () => {
    const generateObject = mock(async ({ model }: { model: any }) => {
      if (model.modelId === "gpt-5-mini") {
        throw new Error("primary unavailable");
      }
      return { object: { title: "Fallback model title" } };
    });
    const getModel = mock((_config: AgentConfig, modelId?: string) => ({ modelId }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      generateObject: generateObject as any,
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
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  test("falls back to deterministic heuristic when all model attempts fail", async () => {
    const generateObject = mock(async (_args: any) => {
      throw new Error("all failed");
    });
    const getModel = mock((_config: AgentConfig, modelId?: string) => ({ modelId }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      generateObject: generateObject as any,
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
    const generateObject = mock(async (_args: any) => ({ object: { title: "unused" } }));
    const getModel = mock((_config: AgentConfig, modelId?: string) => ({ modelId }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      generateObject: generateObject as any,
      getModel: getModel as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({ config: makeConfig("openai"), query: "   " });
    expect(result).toEqual({ title: DEFAULT_SESSION_TITLE, source: "default", model: null });
    expect(generateObject).not.toHaveBeenCalled();
  });
});
