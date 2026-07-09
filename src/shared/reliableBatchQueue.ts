export type ReliableBatchEnvelope<T> = {
  id: string;
  createdAt: string;
  items: T[];
};

export type ReliableBatchDeliveryContext = {
  keepalive: boolean;
};

export type ReliableBatchFailureReason = "permanent" | "retries_exhausted" | "persistence";

export type ReliableBatchFailure<T> = {
  batch: ReliableBatchEnvelope<T>;
  reason: ReliableBatchFailureReason;
  attempts: number;
  error: Error;
};

export type ReliableBatchQueueSnapshot<T> = {
  blocked: boolean;
  batches: ReliableBatchEnvelope<T>[];
};

export type ReliableBatchStore<T> = {
  load: () => ReliableBatchEnvelope<T>[];
  save: (batches: ReliableBatchEnvelope<T>[]) => void;
};

export type ReliableBatchQueueOptions<T> = {
  store: ReliableBatchStore<T>;
  send: (batch: ReliableBatchEnvelope<T>, context: ReliableBatchDeliveryContext) => Promise<void>;
  createId: () => string;
  nowIso: () => string;
  onFailure?: (failure: ReliableBatchFailure<T>) => void;
  sleep?: (delayMs: number) => Promise<void>;
  retryDelayMs?: (failedAttempt: number) => number;
  maxAttempts?: number;
};

export class ReliableBatchDeliveryError extends Error {
  readonly kind: "transient" | "permanent";

  constructor(kind: "transient" | "permanent", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReliableBatchDeliveryError";
    this.kind = kind;
  }
}

const defaultSleep = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
};

const defaultRetryDelayMs = (failedAttempt: number): number =>
  Math.min(4_000, 250 * 2 ** Math.max(0, failedAttempt - 1));

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function cloneBatch<T>(batch: ReliableBatchEnvelope<T>): ReliableBatchEnvelope<T> {
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    items: [...batch.items],
  };
}

export class ReliableBatchQueue<T> {
  private readonly store: ReliableBatchStore<T>;
  private readonly sendBatch: ReliableBatchQueueOptions<T>["send"];
  private readonly createId: () => string;
  private readonly nowIso: () => string;
  private readonly onFailure?: ReliableBatchQueueOptions<T>["onFailure"];
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly retryDelayMs: (failedAttempt: number) => number;
  private readonly maxAttempts: number;
  private batches: ReliableBatchEnvelope<T>[];
  private blocked = false;
  private processing: Promise<void> | null = null;

  constructor(options: ReliableBatchQueueOptions<T>) {
    this.store = options.store;
    this.sendBatch = options.send;
    this.createId = options.createId;
    this.nowIso = options.nowIso;
    this.onFailure = options.onFailure;
    this.sleep = options.sleep ?? defaultSleep;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.batches = options.store.load().map(cloneBatch);
    this.scheduleProcessing();
  }

  enqueue(items: T[]): string | null {
    if (items.length === 0) {
      return null;
    }
    const batch: ReliableBatchEnvelope<T> = {
      id: this.createId(),
      createdAt: this.nowIso(),
      items: [...items],
    };
    this.batches.push(batch);
    this.persist(batch);
    this.scheduleProcessing();
    return batch.id;
  }

  async flush(): Promise<ReliableBatchQueueSnapshot<T>> {
    this.scheduleProcessing();
    while (this.processing) {
      await this.processing;
    }
    return this.snapshot();
  }

  async retry(): Promise<ReliableBatchQueueSnapshot<T>> {
    this.blocked = false;
    return await this.flush();
  }

  async flushForShutdown(): Promise<void> {
    const batch = this.batches[0];
    if (!batch) {
      return;
    }
    try {
      await this.sendBatch(cloneBatch(batch), { keepalive: true });
    } catch {
      // Pending data was persisted before delivery. Keep it for the next startup,
      // where the normal ordered retry path resumes with the same idempotency key.
    }
  }

  snapshot(): ReliableBatchQueueSnapshot<T> {
    return {
      blocked: this.blocked,
      batches: this.batches.map(cloneBatch),
    };
  }

  private scheduleProcessing(): void {
    if (this.processing || this.blocked || this.batches.length === 0) {
      return;
    }
    this.processing = Promise.resolve()
      .then(async () => {
        await this.processPending();
      })
      .finally(() => {
        this.processing = null;
        if (!this.blocked && this.batches.length > 0) {
          this.scheduleProcessing();
        }
      });
  }

  private async processPending(): Promise<void> {
    while (!this.blocked) {
      const batch = this.batches[0];
      if (!batch) {
        return;
      }

      const acknowledged = await this.deliver(batch);
      if (!acknowledged) {
        this.blocked = true;
        return;
      }

      if (this.batches[0]?.id === batch.id) {
        this.batches.shift();
        this.persist(batch);
      }
    }
  }

  private async deliver(batch: ReliableBatchEnvelope<T>): Promise<boolean> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await this.sendBatch(cloneBatch(batch), { keepalive: false });
        return true;
      } catch (error) {
        const normalizedError = toError(error);
        const isPermanent =
          normalizedError instanceof ReliableBatchDeliveryError &&
          normalizedError.kind === "permanent";
        if (isPermanent) {
          this.reportFailure({
            batch,
            reason: "permanent",
            attempts: attempt,
            error: normalizedError,
          });
          return false;
        }
        if (attempt === this.maxAttempts) {
          this.reportFailure({
            batch,
            reason: "retries_exhausted",
            attempts: attempt,
            error: normalizedError,
          });
          return false;
        }
        await this.sleep(Math.max(0, this.retryDelayMs(attempt)));
      }
    }
    return false;
  }

  private persist(batch: ReliableBatchEnvelope<T>): void {
    try {
      this.store.save(this.batches.map(cloneBatch));
    } catch (error) {
      this.reportFailure({
        batch,
        reason: "persistence",
        attempts: 0,
        error: toError(error),
      });
    }
  }

  private reportFailure(failure: ReliableBatchFailure<T>): void {
    try {
      this.onFailure?.({
        ...failure,
        batch: cloneBatch(failure.batch),
      });
    } catch {
      // Failure reporting must never break queue ordering or retention.
    }
  }
}
