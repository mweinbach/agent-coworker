import { describe, expect, test } from "bun:test";

import { IdempotencyConflictError, IdempotencyLedger } from "../src/shared/idempotencyLedger";

type Receipt = {
  turnId: string;
};

describe("IdempotencyLedger", () => {
  test("rehydrates an accepted key with its original payload fingerprint", async () => {
    const ledger = new IdempotencyLedger<Receipt>();
    ledger.seedAccepted("message-1", "fingerprint-a", { turnId: "turn-1" });

    const replay = ledger.claim("message-1", "fingerprint-a");
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("Expected a replay claim.");
    expect(await replay.outcome).toEqual({
      status: "accepted",
      value: { turnId: "turn-1" },
    });

    expect(() => ledger.claim("message-1", "fingerprint-b")).toThrow(IdempotencyConflictError);
  });

  test("retains accepted keys for the entire in-memory conversation horizon", () => {
    const ledger = new IdempotencyLedger<Receipt>();
    for (let index = 0; index < 1_025; index += 1) {
      const key = `message-${index}`;
      const claim = ledger.claim(key, `fingerprint-${index}`);
      expect(claim.kind).toBe("owner");
      ledger.accept(key, { turnId: `turn-${index}` });
    }

    expect(() => ledger.claim("message-0", "different-fingerprint")).toThrow(
      IdempotencyConflictError,
    );
  });
});
