import { describe, expect, test } from "bun:test";

import {
  parseServerRequestReceipt,
  ServerRequestReceiptLedger,
  serverRequestResponsesEqual,
} from "../../src/server/jsonrpc/serverRequestReceipts";
import type { PersistedThreadJournalEvent } from "../../src/server/sessionDb";

function resolvedEvent(overrides: {
  eventType?: PersistedThreadJournalEvent["eventType"];
  payload?: unknown;
  ts?: string;
}): PersistedThreadJournalEvent {
  return {
    threadId: "thread-1",
    seq: 1,
    ts: overrides.ts ?? "2026-07-11T09:00:00.000Z",
    eventType: overrides.eventType ?? "serverRequest/resolved",
    turnId: "turn-1",
    itemId: null,
    requestId: "ask-1",
    payload: overrides.payload ?? {
      threadId: "thread-1",
      requestId: "ask-1",
      response: { kind: "ask", answer: "first" },
    },
  };
}

describe("ServerRequestReceiptLedger first-write wins", () => {
  test("parseServerRequestReceipt ignores non-resolution events and malformed payloads", () => {
    expect(
      parseServerRequestReceipt(
        resolvedEvent({
          eventType: "item/agentMessage",
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        resolvedEvent({
          payload: {
            threadId: "thread-1",
            requestId: "   ",
            response: { kind: "ask", answer: "first" },
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        resolvedEvent({
          payload: {
            threadId: "thread-1",
            requestId: "ask-1",
            response: { kind: "ask", approved: true },
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        resolvedEvent({
          payload: {
            threadId: "thread-1",
            requestId: "ask-1",
            response: { kind: "approval", approved: true, extra: true },
          },
        }),
      ),
    ).toBeNull();
  });

  test("remember keeps the first response when a later replay disagrees", () => {
    const ledger = new ServerRequestReceiptLedger({
      now: () => Date.parse("2026-07-11T09:00:00.000Z"),
    });
    const first = ledger.remember({
      threadId: "thread-1",
      requestId: "ask-1",
      response: { kind: "ask", answer: "original" },
      resolvedAt: "2026-07-11T09:00:00.000Z",
    });
    const replay = ledger.remember({
      threadId: "thread-1",
      requestId: "ask-1",
      response: { kind: "ask", answer: "tampered" },
      resolvedAt: "2026-07-11T09:00:01.000Z",
    });

    expect(replay).toEqual(first);
    expect(ledger.get("thread-1", "ask-1")?.response).toEqual({
      kind: "ask",
      answer: "original",
    });
    expect(
      serverRequestResponsesEqual(
        { kind: "ask", answer: "original" },
        { kind: "ask", answer: "tampered" },
      ),
    ).toBe(false);
    expect(
      serverRequestResponsesEqual(
        { kind: "ask", answer: "original" },
        { kind: "approval", approved: true },
      ),
    ).toBe(false);
    expect(
      serverRequestResponsesEqual(
        { kind: "approval", approved: true },
        { kind: "approval", approved: true },
      ),
    ).toBe(true);
  });
});
