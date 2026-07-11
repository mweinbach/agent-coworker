import { z } from "zod";

import type { PersistedThreadJournalEvent } from "../sessionDb";

export const SERVER_REQUEST_RECEIPT_HORIZON_MS = 5 * 60 * 1_000;
export const MAX_SERVER_REQUEST_RECEIPTS = 128;
export const SERVER_REQUEST_RECEIPT_SCAN_LIMIT = 512;

export type ServerRequestResponse =
  | { kind: "ask"; answer: string }
  | { kind: "approval"; approved: boolean };

export type ServerRequestReceipt = {
  threadId: string;
  requestId: string;
  response: ServerRequestResponse;
  resolvedAt: string;
};

export const serverRequestResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ask"), answer: z.string() }).strict(),
  z.object({ kind: z.literal("approval"), approved: z.boolean() }).strict(),
]);

const resolvedServerRequestPayloadSchema = z
  .object({
    threadId: z.string().trim().min(1),
    requestId: z.string().trim().min(1),
    response: serverRequestResponseSchema,
  })
  .strict();

function receiptKey(threadId: string, requestId: string): string {
  return `${threadId}\u0000${requestId}`;
}

export function serverRequestResponsesEqual(
  left: ServerRequestResponse,
  right: ServerRequestResponse,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "ask" && right.kind === "ask"
    ? left.answer === right.answer
    : left.kind === "approval" && right.kind === "approval" && left.approved === right.approved;
}

export function parseServerRequestReceipt(
  event: PersistedThreadJournalEvent,
): ServerRequestReceipt | null {
  if (event.eventType !== "serverRequest/resolved") return null;
  const parsed = resolvedServerRequestPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    resolvedAt: event.ts,
  };
}

export function serverRequestResolvedPayload(receipt: ServerRequestReceipt): {
  threadId: string;
  requestId: string;
  response: ServerRequestResponse;
} {
  return {
    threadId: receipt.threadId,
    requestId: receipt.requestId,
    response: receipt.response,
  };
}

export class ServerRequestReceiptLedger {
  private readonly receipts = new Map<string, ServerRequestReceipt>();

  constructor(
    private readonly opts: {
      horizonMs?: number;
      maxEntries?: number;
      now?: () => number;
    } = {},
  ) {}

  remember(receipt: ServerRequestReceipt): ServerRequestReceipt {
    this.prune();
    const key = receiptKey(receipt.threadId, receipt.requestId);
    const existing = this.receipts.get(key);
    if (existing) return existing;
    this.receipts.set(key, receipt);
    this.prune();
    return receipt;
  }

  hydrate(events: readonly PersistedThreadJournalEvent[]): void {
    for (const event of events) {
      const receipt = parseServerRequestReceipt(event);
      if (receipt) {
        this.remember(receipt);
      }
    }
  }

  get(threadId: string, requestId: string): ServerRequestReceipt | null {
    this.prune();
    return this.receipts.get(receiptKey(threadId, requestId)) ?? null;
  }

  listForThread(threadId: string): ServerRequestReceipt[] {
    this.prune();
    return [...this.receipts.values()].filter((receipt) => receipt.threadId === threadId);
  }

  private prune(): void {
    const now = (this.opts.now ?? Date.now)();
    const horizonMs = Math.max(0, this.opts.horizonMs ?? SERVER_REQUEST_RECEIPT_HORIZON_MS);
    for (const [key, receipt] of this.receipts) {
      const resolvedAt = Date.parse(receipt.resolvedAt);
      if (!Number.isFinite(resolvedAt) || now - resolvedAt > horizonMs) {
        this.receipts.delete(key);
      }
    }

    const maxEntries = Math.max(1, this.opts.maxEntries ?? MAX_SERVER_REQUEST_RECEIPTS);
    while (this.receipts.size > maxEntries) {
      const oldestKey = this.receipts.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.receipts.delete(oldestKey);
    }
  }
}
