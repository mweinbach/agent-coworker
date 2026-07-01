import { describe, expect, test } from "bun:test";

import { ThreadJournal } from "../src/server/runtime/ThreadJournal";
import type {
  PersistedThreadJournalEvent,
  PersistedThreadJournalFailure,
} from "../src/server/sessionDb";

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
});
