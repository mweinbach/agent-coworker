import { describe, expect, test } from "bun:test";

import { ThreadJournal } from "../src/server/runtime/ThreadJournal";
import type { PersistedThreadJournalEvent } from "../src/server/sessionDb";

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
    let appendCalls = 0;
    const journal = new ThreadJournal({
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
    } as never);

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
  });
});
