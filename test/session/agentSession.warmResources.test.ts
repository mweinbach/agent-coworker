import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeConfig,
  makeSession,
  mockRunTurn,
  REAL_AGENT,
  resetAgentSessionMocks,
  waitForCondition,
} from "./agentSession.harness";

describe("AgentSession.warmSessionResources", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  test("warms the system prompt once and the first user message reuses it", async () => {
    const loadSystemPromptWithSkills = mock(async () => ({
      prompt: "Warmed system prompt",
      discoveredSkills: [{ name: "warm-skill", description: "Warmed" }],
    }));
    const { session } = makeSession({
      system: "",
      discoveredSkills: undefined,
      loadSystemPromptWithSkillsImpl: loadSystemPromptWithSkills,
    });

    session.warmSessionResources();
    await waitForCondition(() => loadSystemPromptWithSkills.mock.calls.length === 1);

    await session.sendUserMessage("hello");

    expect(loadSystemPromptWithSkills).toHaveBeenCalledTimes(1);
    expect(mockRunTurn).toHaveBeenCalledTimes(1);
    const runTurnParams = mockRunTurn.mock.calls[0]?.[0] as { system?: string } | undefined;
    expect(runTurnParams?.system).toBe("Warmed system prompt");
  });

  test("first user message awaits an in-flight warm load instead of starting a second one", async () => {
    let releaseLoad: (() => void) | undefined;
    const loadStarted = Promise.withResolvers<void>();
    const loadSystemPromptWithSkills = mock(async () => {
      loadStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      return { prompt: "Slow warmed prompt", discoveredSkills: [] };
    });
    const { session } = makeSession({
      system: "",
      discoveredSkills: undefined,
      loadSystemPromptWithSkillsImpl: loadSystemPromptWithSkills,
    });

    session.warmSessionResources();
    await loadStarted.promise;

    const sendPromise = session.sendUserMessage("hello while warming");
    releaseLoad?.();
    await sendPromise;

    expect(loadSystemPromptWithSkills).toHaveBeenCalledTimes(1);
    const runTurnParams = mockRunTurn.mock.calls[0]?.[0] as { system?: string } | undefined;
    expect(runTurnParams?.system).toBe("Slow warmed prompt");
  });

  test("warms the workspace MCP cache when MCP is enabled", async () => {
    const getOrLoadMCPToolsCached = mock(async () => ({ tools: {}, errors: [] }));
    const config = { ...makeConfig("/tmp/test-session"), enableMcp: true };
    const { session } = makeSession({
      config,
      getOrLoadMCPToolsCachedImpl: getOrLoadMCPToolsCached,
    });

    session.warmSessionResources();
    await waitForCondition(() => getOrLoadMCPToolsCached.mock.calls.length === 1);

    expect(getOrLoadMCPToolsCached).toHaveBeenCalledWith(
      expect.objectContaining({ enableMcp: true }),
      session.id,
      expect.any(Object),
    );
  });

  test("skips the MCP warm when MCP is disabled", async () => {
    const getOrLoadMCPToolsCached = mock(async () => ({ tools: {}, errors: [] }));
    const config = { ...makeConfig("/tmp/test-session"), enableMcp: false };
    const { session } = makeSession({
      config,
      getOrLoadMCPToolsCachedImpl: getOrLoadMCPToolsCached,
    });

    session.warmSessionResources();
    await Promise.resolve();

    expect(getOrLoadMCPToolsCached).not.toHaveBeenCalled();
  });

  test("warm failures do not break the first user message", async () => {
    let loadAttempts = 0;
    const loadSystemPromptWithSkills = mock(async () => {
      loadAttempts += 1;
      if (loadAttempts === 1) {
        throw new Error("warm load failed");
      }
      return { prompt: "Recovered prompt", discoveredSkills: [] };
    });
    const getOrLoadMCPToolsCached = mock(async () => {
      throw new Error("mcp warm failed");
    });
    const config = { ...makeConfig("/tmp/test-session"), enableMcp: true };
    const { session } = makeSession({
      config,
      system: "",
      discoveredSkills: undefined,
      loadSystemPromptWithSkillsImpl: loadSystemPromptWithSkills,
      getOrLoadMCPToolsCachedImpl: getOrLoadMCPToolsCached,
    });

    session.warmSessionResources();
    await waitForCondition(() => loadAttempts === 1);

    await session.sendUserMessage("hello after warm failure");

    expect(loadAttempts).toBe(2);
    expect(mockRunTurn).toHaveBeenCalledTimes(1);
    const runTurnParams = mockRunTurn.mock.calls[0]?.[0] as { system?: string } | undefined;
    expect(runTurnParams?.system).toBe("Recovered prompt");
  });

  test("a concurrent prompt refresh is not clobbered by a slower warm load", async () => {
    let releaseWarmLoad: (() => void) | undefined;
    const warmLoadStarted = Promise.withResolvers<void>();
    const loadSystemPromptWithSkills = mock(async () => {
      warmLoadStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseWarmLoad = resolve;
      });
      return { prompt: "Stale warmed prompt", discoveredSkills: [] };
    });
    const { session } = makeSession({
      system: "",
      discoveredSkills: undefined,
      loadSystemPromptWithSkillsImpl: loadSystemPromptWithSkills,
    });

    session.warmSessionResources();
    await warmLoadStarted.promise;

    // A config mutation refreshes the prompt while the warm load is in flight.
    loadSystemPromptWithSkills.mockImplementationOnce(async () => ({
      prompt: "Refreshed prompt",
      discoveredSkills: [],
    }));
    await session.refreshSystemPromptWithSkills("test.concurrent_refresh");

    releaseWarmLoad?.();
    await session.sendUserMessage("hello");

    const runTurnParams = mockRunTurn.mock.calls[0]?.[0] as { system?: string } | undefined;
    expect(runTurnParams?.system).toBe("Refreshed prompt");
  });
});
