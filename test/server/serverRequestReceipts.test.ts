import { describe, expect, test } from "bun:test";

import {
  parseServerRequestReceipt,
  ServerRequestReceiptLedger,
  serverRequestResponsesEqual,
} from "../../src/server/jsonrpc/serverRequestReceipts";
import type { PersistedThreadJournalEvent } from "../../src/server/sessionDb";

function resolvedEvent(
  seq: number,
  requestId: string,
  resolvedAt: string,
): PersistedThreadJournalEvent {
  return {
    threadId: "thread-1",
    seq,
    ts: resolvedAt,
    eventType: "serverRequest/resolved",
    turnId: "turn-1",
    itemId: null,
    requestId,
    payload: {
      threadId: "thread-1",
      requestId,
      response: { kind: "ask", answer: requestId },
    },
  };
}

describe("ServerRequestReceiptLedger", () => {
  test("hydrates canonical response results from persisted resolution events", () => {
    const event = resolvedEvent(1, "ask-1", "2026-07-11T09:00:00.000Z");
    expect(parseServerRequestReceipt(event)).toEqual({
      threadId: "thread-1",
      requestId: "ask-1",
      response: { kind: "ask", answer: "ask-1" },
      resolvedAt: "2026-07-11T09:00:00.000Z",
    });
    expect(
      serverRequestResponsesEqual(
        { kind: "approval", approved: true },
        { kind: "approval", approved: false },
      ),
    ).toBe(false);
  });

  test("bounds reconnect receipts by both age and entry count", () => {
    let now = Date.parse("2026-07-11T09:00:00.000Z");
    const ledger = new ServerRequestReceiptLedger({
      horizonMs: 1_000,
      maxEntries: 2,
      now: () => now,
    });

    ledger.hydrate([
      resolvedEvent(1, "ask-1", new Date(now).toISOString()),
      resolvedEvent(2, "ask-2", new Date(now + 100).toISOString()),
      resolvedEvent(3, "ask-3", new Date(now + 200).toISOString()),
    ]);
    expect(ledger.get("thread-1", "ask-1")).toBeNull();
    expect(ledger.listForThread("thread-1").map((receipt) => receipt.requestId)).toEqual([
      "ask-2",
      "ask-3",
    ]);

    now += 1_201;
    expect(ledger.listForThread("thread-1")).toEqual([]);
  });
});
