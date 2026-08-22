import { describe, expect, test } from "bun:test";

import {
  parseServerRequestReceipt,
  ServerRequestReceiptLedger,
} from "../../src/server/jsonrpc/serverRequestReceipts";
import type { PersistedThreadJournalEvent } from "../../src/server/sessionDb";

function event(
  overrides: Partial<PersistedThreadJournalEvent> & {
    payload?: unknown;
  } = {},
): PersistedThreadJournalEvent {
  return {
    threadId: "thread-1",
    seq: 1,
    ts: "2026-08-22T10:00:00.000Z",
    eventType: "serverRequest/resolved",
    turnId: "turn-1",
    itemId: null,
    requestId: "ask-1",
    payload: {
      threadId: "thread-1",
      requestId: "ask-1",
      response: { kind: "ask", answer: "ok" },
    },
    ...overrides,
  };
}

describe("parseServerRequestReceipt malformed journal rows", () => {
  test("drops non-resolution events and invalid resolution payloads", () => {
    expect(
      parseServerRequestReceipt(
        event({
          eventType: "item/completed",
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        event({
          payload: {
            threadId: "thread-1",
            requestId: "",
            response: { kind: "ask", answer: "ok" },
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        event({
          payload: {
            threadId: "   ",
            requestId: "ask-1",
            response: { kind: "ask", answer: "ok" },
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        event({
          payload: {
            threadId: "thread-1",
            requestId: "ask-1",
            response: { kind: "decline", approved: true },
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        event({
          payload: {
            threadId: "thread-1",
            requestId: "ask-1",
            response: { kind: "ask", answer: "ok" },
            extra: true,
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        event({
          payload: {
            threadId: "thread-1",
            requestId: "ask-1",
            response: { kind: "approval", approved: true, extra: "nope" },
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseServerRequestReceipt(
        event({
          payload: {
            threadId: "thread-1",
            requestId: "ask-1",
            response: "approved",
          },
        }),
      ),
    ).toBeNull();
  });

  test("hydrate keeps only canonical receipts", () => {
    const ledger = new ServerRequestReceiptLedger({
      now: () => Date.parse("2026-08-22T10:00:00.000Z"),
    });
    ledger.hydrate([
      event({
        seq: 1,
        requestId: "bad-1",
        payload: {
          threadId: "thread-1",
          requestId: "",
          response: { kind: "ask", answer: "nope" },
        },
      }),
      event({
        seq: 2,
        requestId: "ask-ok",
        payload: {
          threadId: "thread-1",
          requestId: "ask-ok",
          response: { kind: "approval", approved: false },
        },
      }),
      event({
        seq: 3,
        requestId: "bad-2",
        payload: {
          threadId: "thread-1",
          requestId: "bad-2",
          response: { kind: "ask", answer: "ok", note: "extra" },
        },
      }),
    ]);

    expect(ledger.get("thread-1", "bad-1")).toBeNull();
    expect(ledger.get("thread-1", "bad-2")).toBeNull();
    expect(ledger.get("thread-1", "ask-ok")).toEqual({
      threadId: "thread-1",
      requestId: "ask-ok",
      response: { kind: "approval", approved: false },
      resolvedAt: "2026-08-22T10:00:00.000Z",
    });
    expect(ledger.listForThread("thread-1")).toHaveLength(1);
  });
});
