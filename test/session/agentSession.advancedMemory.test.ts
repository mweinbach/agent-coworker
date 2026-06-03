import { describe, expect, mock, test } from "bun:test";

import type { ModelMessage } from "../../src/types";
import {
  AgentSession,
  flushAsyncWork,
  makeConfig,
  makeEmit,
  makeSession,
  makeSessionBackupFactory,
  waitForCondition,
} from "./agentSession.harness";

type MemoryGenerationSessionInternals = {
  memoryGenerator: {
    run: (opts: { deltaMessages: ModelMessage[] }) => Promise<{ ran: boolean; ok: boolean }>;
    consolidate: (opts: { folder?: string }) => Promise<{ ran: boolean; ok: boolean }>;
  };
  memoryGenerationQueue: Promise<void>;
  state: {
    allMessages: ModelMessage[];
    lastMemoryGeneratedIndex: number;
    memoryGenerationsSinceConsolidation: number;
  };
};

type PersistedMemoryCheckpointSnapshot = {
  context: {
    lastMemoryGeneratedIndex?: number;
  };
};

describe("AgentSession advanced memory generation", () => {
  test("snapshots the completed-turn boundary when queueing generation", async () => {
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session } = makeSession({ config });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    const deltas: ModelMessage[][] = [];
    let resolveStarted!: () => void;
    let resolveRun!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const unblockRun = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });

    internals.memoryGenerator = {
      run: async ({ deltaMessages }) => {
        deltas.push(deltaMessages);
        resolveStarted();
        await unblockRun;
        return { ran: true, ok: true };
      },
      consolidate: async () => {
        throw new Error("consolidation should not run before five generations");
      },
    };

    internals.state.allMessages.push(
      { role: "user", content: "first turn" } as ModelMessage,
      { role: "assistant", content: "first answer" } as ModelMessage,
    );
    session.triggerMemoryGeneration();
    internals.state.allMessages.push({ role: "user", content: "second turn" } as ModelMessage);

    await started;
    resolveRun();
    await internals.memoryGenerationQueue;

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.map((message) => message.content)).toEqual(["first turn", "first answer"]);
    expect(internals.state.lastMemoryGeneratedIndex).toBe(2);
  });

  test("refreshes the system prompt after generated memories can change the index", async () => {
    let refreshCount = 0;
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session } = makeSession({
      config,
      loadSystemPromptWithSkillsImpl: async () => {
        refreshCount += 1;
        return { prompt: `refreshed-${refreshCount}`, discoveredSkills: [] };
      },
    });
    const internals = session as unknown as MemoryGenerationSessionInternals & {
      state: MemoryGenerationSessionInternals["state"] & { system: string };
    };
    internals.memoryGenerator = {
      run: async () => ({ ran: true, ok: true }),
      consolidate: async () => {
        throw new Error("consolidation should not run before five generations");
      },
    };

    internals.state.allMessages.push({ role: "user", content: "remember this" } as ModelMessage);
    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    expect(refreshCount).toBe(1);
    expect(internals.state.system).toBe("refreshed-1");
  });

  test("emits the refreshed advanced memory list after automatic generation", async () => {
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session, events } = makeSession({
      config,
      loadSystemPromptWithSkillsImpl: async () => ({ prompt: "refreshed", discoveredSkills: [] }),
    });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    internals.memoryGenerator = {
      run: async () => ({ ran: true, ok: true }),
      consolidate: async () => {
        throw new Error("consolidation should not run before five generations");
      },
    };

    internals.state.allMessages.push(
      { role: "user", content: "remember this" } as ModelMessage,
      { role: "assistant", content: "remembered" } as ModelMessage,
    );
    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    const advancedMemoryEvents = events.filter((event) => event.type === "advanced_memory_list");
    expect(advancedMemoryEvents).toHaveLength(1);
    expect(advancedMemoryEvents[0]?.sessionId).toBe(session.id);
  });

  test("persists the automatic generation checkpoint after a successful run", async () => {
    const snapshots: unknown[] = [];
    const writePersistedSessionSnapshotImpl = mock(async (opts: { snapshot: unknown }) => {
      snapshots.push(opts.snapshot);
      return "/tmp/test-session/.cowork/sessions/mock.json";
    });
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session } = makeSession({ config, writePersistedSessionSnapshotImpl });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    await flushAsyncWork();
    snapshots.length = 0;

    internals.memoryGenerator = {
      run: async () => ({ ran: true, ok: true }),
      consolidate: async () => {
        throw new Error("consolidation should not run before five generations");
      },
    };

    internals.state.allMessages.push(
      { role: "user", content: "persist this" } as ModelMessage,
      { role: "assistant", content: "persisted" } as ModelMessage,
    );
    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    await waitForCondition(() => snapshots.length > 0);
    const latestSnapshot = snapshots.at(-1) as PersistedMemoryCheckpointSnapshot | undefined;
    expect(latestSnapshot?.context.lastMemoryGeneratedIndex).toBe(2);
  });

  test("resumes automatic generation from the persisted checkpoint", async () => {
    const messages = [
      { role: "user", content: "already processed" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "needs retry" },
      { role: "assistant", content: "new answer" },
    ] as ModelMessage[];
    const { emit } = makeEmit();
    const session = AgentSession.fromPersisted({
      persisted: {
        sessionId: "persisted-memory-session",
        sessionKind: "root",
        parentSessionId: null,
        role: null,
        title: "Persisted",
        titleSource: "manual",
        titleModel: null,
        provider: "google",
        model: "gemini-3-flash-preview",
        workingDirectory: "/tmp/test-session",
        enableMcp: true,
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:01.000Z",
        status: "active",
        hasPendingAsk: false,
        hasPendingApproval: false,
        messageCount: messages.length,
        lastEventSeq: 1,
        systemPrompt: "system",
        messages,
        lastMemoryGeneratedIndex: 2,
        providerState: null,
        todos: [],
        harnessContext: null,
        costTracker: null,
      },
      baseConfig: { ...makeConfig("/tmp/test-session"), advancedMemory: true },
      discoveredSkills: [{ name: "test-skill", description: "Test skill" }],
      emit,
      sessionBackupFactory: makeSessionBackupFactory(),
      getProviderStatusesImpl: async () => [],
    });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    const deltas: ModelMessage[][] = [];
    internals.memoryGenerator = {
      run: async ({ deltaMessages }) => {
        deltas.push(deltaMessages);
        return { ran: false, ok: true };
      },
      consolidate: async () => {
        throw new Error("consolidation should not run for a no-op generation");
      },
    };

    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.map((message) => message.content)).toEqual(["needs retry", "new answer"]);
    expect(internals.state.lastMemoryGeneratedIndex).toBe(messages.length);
  });

  test("manual backfill replays completed assistant responses in order", async () => {
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session } = makeSession({ config });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    const deltas: ModelMessage[][] = [];
    const consolidatedFolders: Array<string | undefined> = [];

    internals.memoryGenerator = {
      run: async ({ deltaMessages }) => {
        deltas.push(deltaMessages);
        return { ran: true, ok: true };
      },
      consolidate: async ({ folder }) => {
        consolidatedFolders.push(folder);
        return { ran: true, ok: true };
      },
    };

    internals.state.allMessages.push(
      { role: "user", content: "first question" } as ModelMessage,
      { role: "assistant", content: "first response" } as ModelMessage,
      { role: "user", content: "first follow-up" } as ModelMessage,
      {
        role: "assistant",
        content: [{ type: "tool-call", toolName: "grep", input: { pattern: "memory" } }],
      } as unknown as ModelMessage,
      {
        role: "tool",
        content: [{ type: "tool-result", toolName: "grep", output: { value: "match" } }],
      } as unknown as ModelMessage,
      { role: "assistant", content: "second response" } as ModelMessage,
      { role: "user", content: "second follow-up" } as ModelMessage,
      { role: "assistant", content: "third response" } as ModelMessage,
    );

    await session.generateAdvancedMemoryForHistory("proj");

    expect(deltas.map((chunk) => chunk.map((message) => message.role))).toEqual([
      ["user", "assistant"],
      ["user", "assistant", "tool", "assistant"],
      ["user", "assistant"],
    ]);
    expect(deltas[0]?.map((message) => message.content)).toEqual([
      "first question",
      "first response",
    ]);
    expect(deltas[1]?.at(-1)?.content).toBe("second response");
    expect(deltas[2]?.map((message) => message.content)).toEqual([
      "second follow-up",
      "third response",
    ]);
    expect(consolidatedFolders).toEqual(["proj"]);
  });

  test("manual current-folder backfill checkpoints history before the next automatic generation", async () => {
    const snapshots: unknown[] = [];
    const writePersistedSessionSnapshotImpl = mock(async (opts: { snapshot: unknown }) => {
      snapshots.push(opts.snapshot);
      return "/tmp/test-session/.cowork/sessions/mock.json";
    });
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session } = makeSession({
      config,
      writePersistedSessionSnapshotImpl,
      loadSystemPromptWithSkillsImpl: async () => ({ prompt: "refreshed", discoveredSkills: [] }),
    });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    await flushAsyncWork();
    snapshots.length = 0;
    const deltas: ModelMessage[][] = [];

    internals.memoryGenerator = {
      run: async ({ deltaMessages }) => {
        deltas.push(deltaMessages);
        return { ran: true, ok: true };
      },
      consolidate: async () => ({ ran: false, ok: true }),
    };

    internals.state.allMessages.push(
      { role: "user", content: "old question" } as ModelMessage,
      { role: "assistant", content: "old answer" } as ModelMessage,
      { role: "user", content: "old follow-up" } as ModelMessage,
      { role: "assistant", content: "old follow-up answer" } as ModelMessage,
    );

    await session.generateAdvancedMemoryForHistory();

    expect(internals.state.lastMemoryGeneratedIndex).toBe(4);
    await waitForCondition(() =>
      snapshots.some(
        (snapshot) =>
          (snapshot as PersistedMemoryCheckpointSnapshot).context.lastMemoryGeneratedIndex === 4,
      ),
    );
    expect(deltas.map((chunk) => chunk.map((message) => message.content))).toEqual([
      ["old question", "old answer"],
      ["old follow-up", "old follow-up answer"],
    ]);

    deltas.length = 0;
    internals.state.allMessages.push(
      { role: "user", content: "fresh question" } as ModelMessage,
      { role: "assistant", content: "fresh answer" } as ModelMessage,
    );
    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    expect(deltas.map((chunk) => chunk.map((message) => message.content))).toEqual([
      ["fresh question", "fresh answer"],
    ]);
  });

  test("consolidates after five successful automatic memory generations", async () => {
    let refreshCount = 0;
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session } = makeSession({
      config,
      loadSystemPromptWithSkillsImpl: async () => {
        refreshCount += 1;
        return { prompt: `refreshed-${refreshCount}`, discoveredSkills: [] };
      },
    });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    let runCount = 0;
    let consolidateCount = 0;

    internals.memoryGenerator = {
      run: async () => {
        runCount += 1;
        return { ran: true, ok: true };
      },
      consolidate: async () => {
        consolidateCount += 1;
        return { ran: true, ok: true };
      },
    };

    for (let i = 0; i < 4; i += 1) {
      internals.state.allMessages.push(
        { role: "user", content: `turn ${i}` } as ModelMessage,
        { role: "assistant", content: `answer ${i}` } as ModelMessage,
      );
      session.triggerMemoryGeneration();
      await internals.memoryGenerationQueue;
    }

    expect(runCount).toBe(4);
    expect(consolidateCount).toBe(0);
    expect(internals.state.memoryGenerationsSinceConsolidation).toBe(4);

    internals.state.allMessages.push(
      { role: "user", content: "turn 4" } as ModelMessage,
      { role: "assistant", content: "answer 4" } as ModelMessage,
    );
    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    expect(runCount).toBe(5);
    expect(consolidateCount).toBe(1);
    expect(internals.state.memoryGenerationsSinceConsolidation).toBe(0);
    expect(refreshCount).toBe(5);
  });

  test("does not count no-op or failed generations toward consolidation", async () => {
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session } = makeSession({ config });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    const results = [
      { ran: false, ok: true },
      { ran: true, ok: false },
      { ran: true, ok: true },
      { ran: true, ok: true },
      { ran: true, ok: true },
      { ran: true, ok: true },
      { ran: true, ok: true },
    ];
    let consolidateCount = 0;

    internals.memoryGenerator = {
      run: async () => results.shift() ?? { ran: true, ok: true },
      consolidate: async () => {
        consolidateCount += 1;
        return { ran: true, ok: true };
      },
    };

    for (let i = 0; i < 7; i += 1) {
      internals.state.allMessages.push(
        { role: "user", content: `turn ${i}` } as ModelMessage,
        { role: "assistant", content: `answer ${i}` } as ModelMessage,
      );
      session.triggerMemoryGeneration();
      await internals.memoryGenerationQueue;
    }

    expect(consolidateCount).toBe(1);
    expect(internals.state.memoryGenerationsSinceConsolidation).toBe(0);
  });

  test("retries consolidation after a failed consolidation pass", async () => {
    const config = {
      ...makeConfig("/tmp/test-session"),
      advancedMemory: true,
    };
    const { session } = makeSession({ config });
    const internals = session as unknown as MemoryGenerationSessionInternals;
    internals.state.memoryGenerationsSinceConsolidation = 4;
    let consolidateCount = 0;

    internals.memoryGenerator = {
      run: async () => ({ ran: true, ok: true }),
      consolidate: async () => {
        consolidateCount += 1;
        return consolidateCount === 1 ? { ran: false, ok: false } : { ran: true, ok: true };
      },
    };

    internals.state.allMessages.push(
      { role: "user", content: "first retry" } as ModelMessage,
      { role: "assistant", content: "first answer" } as ModelMessage,
    );
    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    expect(consolidateCount).toBe(1);
    expect(internals.state.memoryGenerationsSinceConsolidation).toBe(5);

    internals.state.allMessages.push(
      { role: "user", content: "second retry" } as ModelMessage,
      { role: "assistant", content: "second answer" } as ModelMessage,
    );
    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    expect(consolidateCount).toBe(2);
    expect(internals.state.memoryGenerationsSinceConsolidation).toBe(0);
  });
});
