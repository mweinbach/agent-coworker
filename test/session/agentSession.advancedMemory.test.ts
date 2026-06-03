import { describe, expect, test } from "bun:test";

import type { ModelMessage } from "../../src/types";
import { makeConfig, makeSession } from "./agentSession.harness";

type MemoryGenerationSessionInternals = {
  memoryGenerator: {
    run: (opts: { deltaMessages: ModelMessage[] }) => Promise<{ ran: boolean; ok: boolean }>;
  };
  memoryGenerationQueue: Promise<void>;
  state: {
    allMessages: ModelMessage[];
    lastMemoryGeneratedIndex: number;
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
    };

    internals.state.allMessages.push({ role: "user", content: "remember this" } as ModelMessage);
    session.triggerMemoryGeneration();
    await internals.memoryGenerationQueue;

    expect(refreshCount).toBe(1);
    expect(internals.state.system).toBe("refreshed-1");
  });
});
