export type IdempotencyOutcome<T> =
  | { status: "accepted"; value: T }
  | { status: "rejected"; message: string };

export type IdempotencyClaim<T> =
  | { kind: "owner"; key: string; fingerprint: string }
  | { kind: "replay"; key: string; outcome: Promise<IdempotencyOutcome<T>> };

type PendingEntry<T> = {
  status: "pending";
  fingerprint: string;
  resolve: (outcome: IdempotencyOutcome<T>) => void;
  outcome: Promise<IdempotencyOutcome<T>>;
};

type AcceptedEntry<T> = {
  status: "accepted";
  fingerprint: string;
  value: T;
};

type Entry<T> = PendingEntry<T> | AcceptedEntry<T>;

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`The idempotency key "${key}" was already used for different input.`);
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyLedger<T> {
  private readonly entries = new Map<string, Entry<T>>();

  claim(key: string, fingerprint: string): IdempotencyClaim<T> {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError(key);
      }
      return {
        kind: "replay",
        key,
        outcome:
          existing.status === "accepted"
            ? Promise.resolve({ status: "accepted", value: existing.value })
            : existing.outcome,
      };
    }

    let resolveOutcome: (outcome: IdempotencyOutcome<T>) => void = () => undefined;
    const outcome = new Promise<IdempotencyOutcome<T>>((resolve) => {
      resolveOutcome = resolve;
    });
    this.entries.set(key, {
      status: "pending",
      fingerprint,
      resolve: resolveOutcome,
      outcome,
    });
    return { kind: "owner", key, fingerprint };
  }

  accept(key: string, value: T): void {
    const existing = this.entries.get(key);
    if (!existing || existing.status === "accepted") return;
    existing.resolve({ status: "accepted", value });
    this.entries.delete(key);
    this.entries.set(key, {
      status: "accepted",
      fingerprint: existing.fingerprint,
      value,
    });
  }

  reject(key: string, message: string): void {
    const existing = this.entries.get(key);
    if (!existing || existing.status === "accepted") return;
    this.entries.delete(key);
    existing.resolve({ status: "rejected", message });
  }

  forgetAccepted(key: string): boolean {
    const existing = this.entries.get(key);
    if (existing?.status !== "accepted") return false;
    return this.entries.delete(key);
  }

  seedAccepted(key: string, fingerprint: string, value: T): void {
    if (this.entries.has(key)) return;
    this.entries.set(key, {
      status: "accepted",
      fingerprint,
      value,
    });
  }
}
