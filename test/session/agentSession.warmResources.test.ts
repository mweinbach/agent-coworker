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

  test("rejects an initial turn whose prompt load was invalidated by history reset", async () => {
    const loadStarted = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const admissions: string[] = [];
    let loads = 0;
    const { session } = makeSession({
      system: "",
      discoveredSkills: undefined,
      loadSystemPromptWithSkillsImpl: async () => {
        if (++loads === 1) {
          loadStarted.resolve();
          await releaseLoad.promise;
          return { prompt: "Pre-reset prompt", discoveredSkills: [] };
        }
        return { prompt: "Fresh prompt", discoveredSkills: [] };
      },
    });
    const firstTurn = session.sendUserMessage(
      "first message",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { onAdmission: (outcome) => admissions.push(outcome.status) },
    );
    try {
      await loadStarted.promise;
      session.reset();
      releaseLoad.resolve();
      await firstTurn;

      expect(mockRunTurn).not.toHaveBeenCalled();
      expect(admissions).toEqual(["rejected"]);

      await session.sendUserMessage("retry after reset");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
      const runTurnParams = mockRunTurn.mock.calls[0]?.[0] as { system?: string } | undefined;
      expect(runTurnParams?.system).toBe("Fresh prompt");
    } finally {
      releaseLoad.resolve();
      await firstTurn;
      session.dispose("test complete");
    }
  });

  test.each(["warm", "refresh"] as const)(
    "detects skill catalog changes made during a %s prompt load",
    async (mode) => {
      let revision = 1;
      const loadStarted = Promise.withResolvers<void>();
      const releaseLoad = Promise.withResolvers<void>();
      let loads = 0;
      const loadSystemPromptWithSkills = mock(async () => {
        const loadedRevision = revision;
        if (++loads === 1) {
          loadStarted.resolve();
          await releaseLoad.promise;
        }
        return {
          prompt: `Prompt revision ${loadedRevision}`,
          discoveredSkills: [{ name: `skill-${loadedRevision}`, description: "Versioned skill" }],
        };
      });
      const { session } = makeSession({
        system: mode === "warm" ? "" : "Original prompt",
        discoveredSkills: mode === "warm" ? undefined : [],
        initialSkillCatalogMtimeSnapshot: "0",
        readSkillCatalogMtimeSnapshotImpl: async () => String(revision),
        loadSystemPromptWithSkillsImpl: loadSystemPromptWithSkills,
      });

      const refresh = mode === "refresh" ? session.refreshSystemPromptWithSkills() : null;
      if (mode === "warm") session.warmSessionResources();
      await loadStarted.promise;
      revision = 2;
      releaseLoad.resolve();
      if (refresh) await refresh;

      // The first send may already be awaiting the warm load. The following
      // turn must still notice that the completed prompt predates the catalog.
      await session.sendUserMessage("first message");
      await session.sendUserMessage("next message");

      const runTurnParams = mockRunTurn.mock.calls.at(-1)?.[0] as
        | { system?: string; discoveredSkills?: Array<{ name: string }> }
        | undefined;
      expect(runTurnParams?.system).toBe("Prompt revision 2");
      expect(runTurnParams?.discoveredSkills).toEqual([
        { name: "skill-2", description: "Versioned skill" },
      ]);
      expect(loadSystemPromptWithSkills).toHaveBeenCalledTimes(2);
    },
  );

  test("an older explicit refresh cannot replace a newer completed prompt", async () => {
    const firstLoadStarted = Promise.withResolvers<void>();
    const releaseFirstLoad = Promise.withResolvers<void>();
    let loads = 0;
    const loadSystemPromptWithSkills = mock(async () => {
      if (++loads === 1) {
        firstLoadStarted.resolve();
        await releaseFirstLoad.promise;
        return { prompt: "Older prompt", discoveredSkills: [] };
      }
      return {
        prompt: "Newer prompt",
        discoveredSkills: [{ name: "newer", description: "Newer" }],
      };
    });
    const { session } = makeSession({ loadSystemPromptWithSkillsImpl: loadSystemPromptWithSkills });

    const olderRefresh = session.refreshSystemPromptWithSkills();
    await firstLoadStarted.promise;
    await session.refreshSystemPromptWithSkills();
    releaseFirstLoad.resolve();
    await olderRefresh;
    await session.sendUserMessage("use the current prompt");

    const runTurnParams = mockRunTurn.mock.calls.at(-1)?.[0] as
      | { system?: string; discoveredSkills?: Array<{ name: string }> }
      | undefined;
    expect(runTurnParams?.system).toBe("Newer prompt");
    expect(runTurnParams?.discoveredSkills).toEqual([{ name: "newer", description: "Newer" }]);
  });
});
