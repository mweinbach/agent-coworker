import { describe, expect, test } from "bun:test";

import type { SessionEvent } from "../src/server/protocol";
import { ThreadJournal } from "../src/server/runtime/ThreadJournal";
import type {
  PersistedThreadJournalEvent,
  PersistedThreadJournalFailure,
} from "../src/server/sessionDb";
import type { SessionBinding } from "../src/server/startServer/types";

function event(threadId: string, eventType: string): Omit<PersistedThreadJournalEvent, "seq"> {
  return {
    threadId,
    ts: "2026-07-01T00:00:00.000Z",
    eventType,
    turnId: null,
    itemId: null,
    requestId: null,
    payload: {},
  };
}

describe("ThreadJournal runtime", () => {
  test("records write failures and keeps later writes flowing", async () => {
    const stored: PersistedThreadJournalEvent[] = [];
    let persistedFailure: PersistedThreadJournalFailure | null = null;
    let appendCalls = 0;
    const journalStore = {
      appendThreadJournalEvents: async (batch: Array<Omit<PersistedThreadJournalEvent, "seq">>) => {
        appendCalls += 1;
        if (appendCalls === 1) {
          throw new Error("database is locked");
        }
        for (const entry of batch) {
          stored.push({ ...entry, seq: stored.length + 1 });
        }
        return batch.map((_, index) => stored.length - batch.length + index + 1);
      },
      listThreadJournalEvents: (threadId: string) =>
        stored.filter((entry) => entry.threadId === threadId),
      getThreadJournalTailSeq: (threadId: string) =>
        stored.filter((entry) => entry.threadId === threadId).at(-1)?.seq ?? 0,
      getThreadJournalFailure: (threadId: string) =>
        persistedFailure?.threadId === threadId ? persistedFailure : null,
      recordThreadJournalFailure: async (failure: PersistedThreadJournalFailure) => {
        persistedFailure = failure;
      },
    };
    const journal = new ThreadJournal(journalStore as never);

    await expect(journal.enqueue(event("thread-1", "turn/started"))).rejects.toThrow(
      "database is locked",
    );
    expect(journal.getHealth("thread-1")).toMatchObject({
      trusted: false,
      failedWriteCount: 1,
      droppedEventCount: 1,
      lastFailureMessage: "database is locked",
    });

    await journal.enqueue(event("thread-1", "turn/completed"));
    await journal.waitForIdle("thread-1");

    expect(journal.list("thread-1").map((entry) => entry.eventType)).toEqual(["turn/completed"]);
    expect(journal.getHealth("thread-1")).toMatchObject({
      trusted: false,
      tailSeq: 1,
      failedWriteCount: 1,
    });

    const restartedJournal = new ThreadJournal(journalStore as never);
    expect(restartedJournal.getHealth("thread-1")).toMatchObject({
      trusted: false,
      tailSeq: 1,
      failedWriteCount: 1,
      droppedEventCount: 1,
      lastFailureMessage: "database is locked",
    });
  });

  test("waitForIdle includes recovery writes accepted during a failed append", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstAppend = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const secondAppend = Promise.withResolvers<void>();
    const stored: string[] = [];
    let appendCalls = 0;
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async (batch: Array<Omit<PersistedThreadJournalEvent, "seq">>) => {
        appendCalls += 1;
        if (appendCalls === 1) {
          firstStarted.resolve();
          await firstAppend.promise;
          throw new Error("first append failed");
        }
        secondStarted.resolve();
        await secondAppend.promise;
        stored.push(...batch.map((entry) => entry.eventType));
        return [];
      },
    } as never);

    const firstWrite = journal.enqueue(event("thread-1", "turn/started")).catch(() => {});
    await firstStarted.promise;
    let secondOutcome = "pending";
    const secondWrite = journal.enqueue(event("thread-1", "turn/completed")).then(
      () => {
        secondOutcome = "resolved";
      },
      () => {
        secondOutcome = "rejected";
      },
    );
    let idleSettled = false;
    const idle = journal.waitForIdle("thread-1").then(() => {
      idleSettled = true;
    });

    try {
      firstAppend.resolve();
      await firstWrite;
      await secondStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(idleSettled).toBe(false);
      expect(secondOutcome).toBe("pending");
    } finally {
      secondAppend.resolve();
      await journal.waitForIdle("thread-1");
      await Promise.all([firstWrite, secondWrite, idle]);
      await journal.close();
    }

    expect(secondOutcome).toBe("resolved");
    expect(stored).toEqual(["turn/completed"]);
  });

  test("each failed append rejects its own enqueue promise", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstAppend = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const secondAppend = Promise.withResolvers<void>();
    const firstError = new Error("first append failed");
    const secondError = new Error("second append failed");
    let appendCalls = 0;
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async () => {
        appendCalls += 1;
        if (appendCalls === 1) {
          firstStarted.resolve();
          await firstAppend.promise;
          throw firstError;
        }
        secondStarted.resolve();
        await secondAppend.promise;
        throw secondError;
      },
      getThreadJournalTailSeq: () => 0,
    } as never);
    const firstWrite = journal
      .enqueue(event("thread-1", "turn/started"))
      .catch((error: unknown) => error);
    await firstStarted.promise;
    const secondWrite = journal
      .enqueue(event("thread-1", "turn/completed"))
      .catch((error: unknown) => error);

    firstAppend.resolve();
    await secondStarted.promise;
    const idle = journal.waitForIdle("thread-1");
    secondAppend.resolve();
    await idle;
    await journal.close();

    expect(await firstWrite).toBe(firstError);
    expect(await secondWrite).toBe(secondError);
    expect(journal.getHealth("thread-1")).toMatchObject({
      failedWriteCount: 2,
      droppedEventCount: 2,
      pendingEventCount: 0,
      pendingThreadCount: 0,
    });
  });

  test("a committed event stays resolved when a later batch fails", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstAppend = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const secondAppend = Promise.withResolvers<void>();
    const secondError = new Error("second append failed");
    let appendCalls = 0;
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async () => {
        appendCalls += 1;
        if (appendCalls === 1) {
          firstStarted.resolve();
          await firstAppend.promise;
          return [];
        }
        secondStarted.resolve();
        await secondAppend.promise;
        throw secondError;
      },
    } as never);
    let firstOutcome = "pending";
    const firstWrite = journal.enqueue(event("thread-1", "turn/started")).then(
      () => {
        firstOutcome = "resolved";
      },
      () => {
        firstOutcome = "rejected";
      },
    );
    await firstStarted.promise;
    const secondWrite = journal
      .enqueue(event("thread-1", "turn/completed"))
      .catch((error: unknown) => error);

    try {
      firstAppend.resolve();
      await secondStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstOutcome).toBe("resolved");
    } finally {
      secondAppend.resolve();
      await journal.waitForIdle("thread-1");
      await firstWrite;
      await journal.close();
    }

    expect(await secondWrite).toBe(secondError);
    expect(firstOutcome).toBe("resolved");
  });

  test("health includes in-flight batches and queued events", async () => {
    const appendStarted = Promise.withResolvers<void>();
    const append = Promise.withResolvers<void>();
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async () => {
        appendStarted.resolve();
        await append.promise;
        return [];
      },
      getThreadJournalTailSeq: () => 0,
    } as never);
    const firstWrite = journal.enqueue(event("thread-1", "turn/started"));
    await appendStarted.promise;
    const queuedWrite = journal.enqueue(event("thread-1", "turn/completed"));
    const otherThreadWrite = journal.enqueue(event("thread-2", "turn/started"));

    try {
      expect(journal.getHealth("thread-1")).toMatchObject({
        pendingEventCount: 2,
        pendingThreadCount: 2,
      });
      expect(journal.getAggregateHealth()).toMatchObject({
        backlog: 3,
        pendingThreadCount: 2,
      });
    } finally {
      const closed = journal.close();
      append.resolve();
      await Promise.all([firstWrite, queuedWrite, otherThreadWrite, closed]);
    }

    expect(journal.getAggregateHealth()).toMatchObject({
      backlog: 0,
      pendingThreadCount: 0,
    });
  });

  test("health reads the journal tail without loading the full event list", () => {
    let listCalls = 0;
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async () => [],
      listThreadJournalEvents: () => {
        listCalls += 1;
        throw new Error("full journal scan should not run");
      },
      getThreadJournalTailSeq: (threadId: string) => (threadId === "thread-1" ? 42 : 0),
    } as never);

    expect(journal.getHealth("thread-1")).toMatchObject({
      trusted: true,
      tailSeq: 42,
    });
    expect(listCalls).toBe(0);
  });

  test("close drains queued writes and ignores later enqueues", async () => {
    const stored: PersistedThreadJournalEvent[] = [];
    let appendCalls = 0;
    let releaseAppend!: () => void;
    const appendBlocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async (batch: Array<Omit<PersistedThreadJournalEvent, "seq">>) => {
        appendCalls += 1;
        await appendBlocked;
        for (const entry of batch) {
          stored.push({ ...entry, seq: stored.length + 1 });
        }
        return batch.map((_, index) => stored.length - batch.length + index + 1);
      },
      listThreadJournalEvents: (threadId: string) =>
        stored.filter((entry) => entry.threadId === threadId),
      getThreadJournalTailSeq: (threadId: string) =>
        stored.filter((entry) => entry.threadId === threadId).at(-1)?.seq ?? 0,
    } as never);

    const queued = journal.enqueue(event("thread-1", "turn/started"));
    let closeSettled = false;
    const closed = journal.close().then(() => {
      closeSettled = true;
    });

    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseAppend();
    await closed;
    await queued;

    await journal.enqueue(event("thread-1", "turn/completed"));

    expect(appendCalls).toBe(1);
    expect(journal.list("thread-1").map((entry) => entry.eventType)).toEqual(["turn/started"]);
  });

  test("close does not reschedule pending events after a failed append", async () => {
    const stored: PersistedThreadJournalEvent[] = [];
    let appendCalls = 0;
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendBlocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async (batch: Array<Omit<PersistedThreadJournalEvent, "seq">>) => {
        appendCalls += 1;
        if (appendCalls === 1) {
          markAppendStarted();
          await appendBlocked;
          throw new Error("database closed during shutdown");
        }
        for (const entry of batch) {
          stored.push({ ...entry, seq: stored.length + 1 });
        }
        return batch.map((_, index) => stored.length - batch.length + index + 1);
      },
      listThreadJournalEvents: (threadId: string) =>
        stored.filter((entry) => entry.threadId === threadId),
      getThreadJournalTailSeq: (threadId: string) =>
        stored.filter((entry) => entry.threadId === threadId).at(-1)?.seq ?? 0,
    } as never);

    const firstWrite = journal
      .enqueue(event("thread-1", "turn/started"))
      .catch((error: unknown) => error);
    await appendStarted;
    const pendingWrite = journal
      .enqueue(event("thread-1", "turn/completed"))
      .catch((error: unknown) => error);

    const closed = journal.close();
    releaseAppend();
    await closed;
    await Promise.resolve();
    await Promise.resolve();

    expect(await firstWrite).toBeInstanceOf(Error);
    expect(await pendingWrite).toBeInstanceOf(Error);
    expect(appendCalls).toBe(1);
    expect(journal.list("thread-1")).toEqual([]);
    expect(journal.getHealth("thread-1")).toMatchObject({
      failedWriteCount: 1,
      droppedEventCount: 2,
      pendingEventCount: 0,
      pendingThreadCount: 0,
    });
  });

  test("close ignores later sink events without touching the store", async () => {
    let appendCalls = 0;
    const binding = {
      sinks: new Map<string, (event: unknown) => void>(),
    };
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async () => {
        appendCalls += 1;
        throw new Error("closed database should not be touched");
      },
      listThreadJournalEvents: () => [],
      getThreadJournalTailSeq: () => 0,
    } as never);

    journal.ensureSink(binding as never, "thread-1", (target, sinkId, sink) => {
      target.sinks.set(sinkId, sink);
    });

    await journal.close();
    binding.sinks.get("journal:thread-1")?.({
      type: "session_info",
      sessionId: "thread-1",
      timestamp: "2026-07-01T00:00:00.000Z",
    });
    await Promise.resolve();

    expect(appendCalls).toBe(0);
  });

  test("projection seeds stay binding-owned and capture does not flush buffered deltas", async () => {
    const stored: Array<Omit<PersistedThreadJournalEvent, "seq">> = [];
    const journal = new ThreadJournal({
      appendThreadJournalEvents: async (batch: Array<Omit<PersistedThreadJournalEvent, "seq">>) => {
        stored.push(...batch);
        return [];
      },
    } as never);
    const binding = { sinks: new Map<string, (event: SessionEvent) => void>() } as SessionBinding;
    const otherBinding = {
      sinks: new Map<string, (event: SessionEvent) => void>(),
    } as SessionBinding;
    const addSink = (target: SessionBinding, id: string, sink: (event: SessionEvent) => void) => {
      target.sinks.set(id, sink);
    };
    journal.ensureSink(binding, "thread-1", addSink);
    const sink = binding.sinks.get("journal:thread-1")!;
    sink({ type: "session_busy", sessionId: "thread-1", busy: true, turnId: "turn-1" });
    sink({
      type: "model_stream_chunk",
      sessionId: "thread-1",
      turnId: "turn-1",
      index: 0,
      provider: "openai",
      model: "gpt-5.4-mini",
      partType: "text_delta",
      part: { id: "s0", text: "Buffered text" },
    });

    try {
      const backlog = journal.getAggregateHealth().backlog;
      const seed = journal.captureProjectionSeed(binding, "thread-1");
      expect(seed?.activeAssistantByTurn.get("turn-1")?.textChunks).toEqual(["Buffered text"]);
      expect(journal.getAggregateHealth().backlog).toBe(backlog);
      seed?.activeAssistantByTurn.get("turn-1")?.textChunks?.push("Modified snapshot");
      journal.ensureSink(binding, "thread-1", addSink);
      expect(
        journal.captureProjectionSeed(binding, "thread-1")?.activeAssistantByTurn.get("turn-1")
          ?.textChunks,
      ).toEqual(["Buffered text"]);
      expect(journal.captureProjectionSeed(otherBinding, "thread-1")).toBeUndefined();
      journal.ensureSink(otherBinding, "thread-1", addSink);
      expect(journal.captureProjectionSeed(otherBinding, "thread-1")?.activeTurnId).toBeNull();

      journal.flushProjection(binding, "thread-1");
      await journal.waitForIdle("thread-1");
      expect(stored.filter((entry) => entry.eventType === "item/agentMessage/delta")).toHaveLength(
        1,
      );
    } finally {
      sink({
        type: "session_busy",
        sessionId: "thread-1",
        busy: false,
        turnId: "turn-1",
        outcome: "completed",
      });
      await journal.close();
    }
    expect(journal.captureProjectionSeed(binding, "thread-1")).toBeUndefined();
    expect(journal.captureProjectionSeed(otherBinding, "thread-1")).toBeUndefined();
  });
});
