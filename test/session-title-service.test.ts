import { describe, expect, mock, test } from "bun:test";

import {
  createSessionTitleGenerator,
  DEFAULT_SESSION_TITLE,
} from "../src/server/sessionTitleService";
import type { AgentConfig } from "../src/types";

function makeConfig(provider: AgentConfig["provider"] = "openai"): AgentConfig {
  return {
    provider,
    model: provider === "openai" ? "gpt-5.2" : "gemini-3-flash-preview",
    preferredChildModel: provider === "openai" ? "gpt-5.2" : "gemini-3-flash-preview",
    workingDirectory: "/tmp/workspace",
    outputDirectory: "/tmp/workspace/output",
    uploadsDirectory: "/tmp/workspace/uploads",
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: "/tmp/workspace/.cowork",
    userCoworkDir: "/tmp/home/.cowork",
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
    const runTurn = mock(async (_args: any) => ({
      text: '  "Hello   World"  ',
      reasoningText: undefined,
      responseMessages: [] as any[],
      usage: undefined,
    }));
    const createRuntime = mock((_config: AgentConfig) => ({ name: "pi", runTurn }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      createRuntime: createRuntime as any,
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
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[0]).toMatchObject({
      providerOptions: {
        openai: {
          reasoningEffort: "low",
        },
      },
    });
  });

  test("falls back to provider default model when primary model attempt fails", async () => {
    const runTurn = mock(async ({ config }: { config: AgentConfig }) => {
      if (config.model === "gpt-5-mini") {
        throw new Error("primary unavailable");
      }
      return {
        text: "Fallback model title",
        reasoningText: undefined,
        responseMessages: [] as any[],
        usage: undefined,
      };
    });
    const createRuntime = mock((_config: AgentConfig) => ({ name: "pi", runTurn }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      createRuntime: createRuntime as any,
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
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  test("uses codex app-server title models with spark fallback", async () => {
    const runTurn = mock(async ({ config }: { config: AgentConfig }) => {
      if (config.model === "gpt-5.4-mini") {
        throw new Error("mini unavailable");
      }
      return {
        text: "Codex Spark Title",
        reasoningText: undefined,
        responseMessages: [] as any[],
        usage: undefined,
      };
    });
    const createRuntime = mock((config: AgentConfig) => ({
      name: "codex-app-server",
      runTurn,
      model: config.model,
    }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.4");

    const generateSessionTitle = createSessionTitleGenerator({
      createRuntime: createRuntime as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });
    const config = {
      ...makeConfig("codex-cli"),
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          textVerbosity: "medium",
        },
      },
    } satisfies AgentConfig;

    const result = await generateSessionTitle({
      config,
      query: "make the title service use app-server model fallback",
    });

    expect(result).toEqual({
      title: "Codex Spark Title",
      source: "model",
      model: "gpt-5.3-codex-spark",
    });
    expect(createRuntime.mock.calls.map(([runtimeConfig]) => runtimeConfig.model)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[1]?.[0]).toMatchObject({
      config: {
        provider: "codex-cli",
        model: "gpt-5.3-codex-spark",
      },
      tools: {},
      maxSteps: 1,
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "low",
          textVerbosity: "medium",
        },
      },
    });
  });

  test("falls back to deterministic heuristic when all model attempts fail", async () => {
    const runTurn = mock(async (_args: any) => {
      throw new Error("all failed");
    });
    const createRuntime = mock((_config: AgentConfig) => ({ name: "pi", runTurn }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      createRuntime: createRuntime as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({
      config: makeConfig("openai"),
      query:
        "build a websocket title service with persistence and protocol updates for desktop and tui",
    });

    expect(result.source).toBe("heuristic");
    expect(result.model).toBeNull();
    expect(result.title.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(result.title.length).toBeLessThanOrEqual(53);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  test("uses runtime turn path", async () => {
    const runTurn = mock(async (_args: any) => ({
      text: '"Runtime  Title"',
      reasoningText: undefined,
      responseMessages: [] as any[],
      usage: undefined,
    }));
    const createRuntime = mock((_config: AgentConfig) => ({
      name: "pi",
      runTurn,
    }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      createRuntime: createRuntime as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({
      config: makeConfig("openai"),
      query: "runtime title path",
    });

    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      title: "Runtime Title",
      source: "model",
      model: "gpt-5-mini",
    });
  });

  test("routes antigravity provider to google provider and gemini-3.1-flash-lite-preview", async () => {
    const runTurn = mock(async (_args: any) => ({
      text: "Antigravity Routed Title",
      reasoningText: undefined,
      responseMessages: [] as any[],
      usage: undefined,
    }));
    const createRuntime = mock((config: AgentConfig) => ({
      name: "google-interactions",
      runTurn,
      model: config.model,
    }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gemini-3.1-flash-lite-preview");

    const generateSessionTitle = createSessionTitleGenerator({
      createRuntime: createRuntime as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({
      config: makeConfig("antigravity"),
      query: "test routing logic",
    });

    expect(result).toEqual({
      title: "Antigravity Routed Title",
      source: "model",
      model: "gemini-3.1-flash-lite-preview",
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(createRuntime.mock.calls[0]?.[0]).toMatchObject({
      provider: "google",
      model: "gemini-3.1-flash-lite-preview",
    });
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  test("returns default title for empty queries", async () => {
    const runTurn = mock(async (_args: any) => ({
      text: "unused",
      reasoningText: undefined,
      responseMessages: [] as any[],
      usage: undefined,
    }));
    const createRuntime = mock((_config: AgentConfig) => ({ name: "pi", runTurn }));
    const defaultModelForProvider = mock((_provider: AgentConfig["provider"]) => "gpt-5.2");

    const generateSessionTitle = createSessionTitleGenerator({
      createRuntime: createRuntime as any,
      defaultModelForProvider: defaultModelForProvider as any,
    });

    const result = await generateSessionTitle({ config: makeConfig("openai"), query: "   " });
    expect(result).toEqual({ title: DEFAULT_SESSION_TITLE, source: "default", model: null });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });
});
