export type ReliableBatchStatus = "pending" | "blocked";

export type ReliableBatchFailureReason =
  | "permanent"
  | "retries_exhausted"
  | "persistence"
  | "overflow"
  | "capability_absent"
  | "malformed";

export type ReliableBatchEnvelope<T> = {
  id: string;
  scope: string;
  destination: string;
  createdAt: number;
  items: T[];
  bytes: number;
  attempts: number;
  nextAttemptAt: number;
  status: ReliableBatchStatus;
  failureReason?: "permanent" | "retries_exhausted";
  lastError?: string;
};

export type ReliableBatchLimits = {
  maxBatches: number;
  maxEvents: number;
  maxBytes: number;
  maxBatchEvents: number;
  maxBatchBytes: number;
};

export type ReliableBatchStats = {
  batches: number;
  events: number;
  bytes: number;
};

export type ReliableBatchEnqueueResult<T> =
  | {
      accepted: true;
      batch: ReliableBatchEnvelope<T>;
      stats: ReliableBatchStats;
    }
  | {
      accepted: false;
      recoveryId: string;
      reason: "overflow" | "batch_too_large" | "capability_absent" | "persistence" | "closed";
      items: T[];
      bytes: number;
      stats: ReliableBatchStats;
      limits: ReliableBatchLimits;
    };

export type ReliableBatchFailure<T> = {
  batchId: string | null;
  recoveryId: string | null;
  items: T[];
  reason: ReliableBatchFailureReason;
  attempts: number;
  error: Error;
  stats: ReliableBatchStats;
  limits: ReliableBatchLimits;
};

export type ReliableBatchDeliveryContext = {
  keepalive: boolean;
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
};

export type ReliableBatchFailureUpdate = {
  attempts: number;
  nextAttemptAt: number;
  status: ReliableBatchStatus;
  failureReason?: "permanent" | "retries_exhausted";
  lastError: string;
};

export type ReliableBatchMalformedRecord = {
  id: string | null;
  message: string;
};

export type ReliableBatchStore<T> = {
  enqueue: (
    batch: ReliableBatchEnvelope<T>,
    limits: ReliableBatchLimits,
  ) => Promise<ReliableBatchEnqueueResult<T>>;
  getHead: (scope: string) => Promise<ReliableBatchEnvelope<T> | null>;
  list: (scope: string) => Promise<ReliableBatchEnvelope<T>[]>;
  stats: (scope: string) => Promise<ReliableBatchStats>;
  acknowledge: (scope: string, batchId: string, ownerId: string) => Promise<boolean>;
  recordFailure: (
    scope: string,
    batchId: string,
    ownerId: string,
    update: ReliableBatchFailureUpdate,
  ) => Promise<boolean>;
  retry: (scope: string, batchId?: string) => Promise<void>;
  discard: (scope: string, batchId: string) => Promise<void>;
  tryAcquireLease: (
    scope: string,
    ownerId: string,
    now: number,
    expiresAt: number,
  ) => Promise<boolean>;
  renewLease: (scope: string, ownerId: string, now: number, expiresAt: number) => Promise<boolean>;
  releaseLease: (scope: string, ownerId: string) => Promise<void>;
  isCapabilityAbsent: (scope: string) => Promise<boolean>;
  markCapabilityAbsentAndClear: (scope: string) => Promise<void>;
  quarantineMalformed: (
    scope: string,
    validate: (value: unknown) => boolean,
  ) => Promise<ReliableBatchMalformedRecord[]>;
};

export type ReliableBatchClock = {
  now: () => number;
};

export type ReliableBatchScheduler = {
  schedule: (delayMs: number, callback: () => void) => unknown;
  cancel: (handle: unknown) => void;
};

export type ReliableBatchQueueOptions<T> = {
  scope: string;
  destination: string;
  store: ReliableBatchStore<T>;
  send: (batch: ReliableBatchEnvelope<T>, context: ReliableBatchDeliveryContext) => Promise<void>;
  createId: () => string;
  measureItems: (items: T[]) => number;
  validateItem: (value: unknown) => value is T;
  clock: ReliableBatchClock;
  scheduler: ReliableBatchScheduler;
  limits: ReliableBatchLimits;
  onFailure?: (failure: ReliableBatchFailure<T>) => void;
  retryDelayMs?: (failedAttempt: number) => number;
  maxAttempts?: number;
  leaseMs?: number;
  ownerRetryMs?: number;
};

export class ReliableBatchDeliveryError extends Error {
  readonly kind: "transient" | "permanent" | "capability_absent";
  readonly retryAfterMs: number | null;

  constructor(
    kind: "transient" | "permanent" | "capability_absent",
    message: string,
    options: ErrorOptions & { retryAfterMs?: number | null } = {},
  ) {
    super(message, options);
    this.name = "ReliableBatchDeliveryError";
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

const EMPTY_STATS: ReliableBatchStats = {
  batches: 0,
  events: 0,
  bytes: 0,
};

const defaultRetryDelayMs = (failedAttempt: number): number =>
  Math.min(30_000, 500 * 2 ** Math.max(0, failedAttempt - 1));

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function cloneBatch<T>(batch: ReliableBatchEnvelope<T>): ReliableBatchEnvelope<T> {
  return {
    ...batch,
    items: structuredClone(batch.items),
  };
}

export function isReliableBatchEnvelope<T>(
  value: unknown,
  validateItem: (value: unknown) => value is T,
): value is ReliableBatchEnvelope<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<ReliableBatchEnvelope<unknown>>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.scope === "string" &&
    record.scope.length > 0 &&
    typeof record.destination === "string" &&
    record.destination.length > 0 &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    Array.isArray(record.items) &&
    record.items.length > 0 &&
    record.items.every(validateItem) &&
    typeof record.bytes === "number" &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes >= 0 &&
    typeof record.attempts === "number" &&
    Number.isSafeInteger(record.attempts) &&
    record.attempts >= 0 &&
    typeof record.nextAttemptAt === "number" &&
    Number.isFinite(record.nextAttemptAt) &&
    (record.status === "pending" || record.status === "blocked") &&
    (record.failureReason === undefined ||
      record.failureReason === "permanent" ||
      record.failureReason === "retries_exhausted") &&
    (record.lastError === undefined || typeof record.lastError === "string")
  );
}

export class ReliableBatchQueue<T> {
  private readonly scope: string;
  private readonly destination: string;
  private readonly store: ReliableBatchStore<T>;
  private readonly sendBatch: ReliableBatchQueueOptions<T>["send"];
  private readonly createId: () => string;
  private readonly measureItems: (items: T[]) => number;
  private readonly validateItem: (value: unknown) => value is T;
  private readonly clock: ReliableBatchClock;
  private readonly scheduler: ReliableBatchScheduler;
  private readonly limits: ReliableBatchLimits;
  private readonly onFailure?: ReliableBatchQueueOptions<T>["onFailure"];
  private readonly retryDelayMs: (failedAttempt: number) => number;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly ownerRetryMs: number;
  private readonly ownerId: string;
  private readonly pendingEnqueues = new Set<Promise<ReliableBatchEnqueueResult<T>>>();
  private readonly reportedFailures = new Set<string>();
  private scheduled: { handle: unknown; at: number } | null = null;
  private running: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private closed = false;
  private shutdownFlushing = false;

  constructor(options: ReliableBatchQueueOptions<T>) {
    this.scope = options.scope;
    this.destination = options.destination;
    this.store = options.store;
    this.sendBatch = options.send;
    this.createId = options.createId;
    this.measureItems = options.measureItems;
    this.validateItem = options.validateItem;
    this.clock = options.clock;
    this.scheduler = options.scheduler;
    this.limits = options.limits;
    this.onFailure = options.onFailure;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 4));
    this.leaseMs = Math.max(1_000, Math.floor(options.leaseMs ?? 30_000));
    this.ownerRetryMs = Math.max(50, Math.floor(options.ownerRetryMs ?? 1_000));
    this.ownerId = this.createId();
    this.scheduleAt(this.clock.now());
  }

  enqueue(items: T[]): Promise<ReliableBatchEnqueueResult<T>> {
    const operation = this.enqueueInternal(items);
    this.pendingEnqueues.add(operation);
    void operation.finally(() => {
      this.pendingEnqueues.delete(operation);
    });
    return operation;
  }

  wake(): void {
    this.scheduleAt(this.clock.now());
  }

  async retry(batchId?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.store.retry(this.scope, batchId);
    if (batchId) {
      this.reportedFailures.delete(batchId);
    } else {
      this.reportedFailures.clear();
    }
    this.wake();
  }

  async discard(batchId: string): Promise<void> {
    await this.store.discard(this.scope, batchId);
    this.reportedFailures.delete(batchId);
    this.wake();
  }

  async snapshot(): Promise<ReliableBatchEnvelope<T>[]> {
    return (await this.store.list(this.scope)).map(cloneBatch);
  }

  abortActive(reason = "Reliable batch delivery interrupted"): void {
    this.activeController?.abort(new Error(reason));
  }

  async flushForShutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    await Promise.allSettled([...this.pendingEnqueues]);
    this.shutdownFlushing = true;
    this.activeController?.abort(new Error("Replaced by transcript shutdown flush"));
    if (this.running) {
      await this.running;
    }
    try {
      const now = this.clock.now();
      const ownsLease = await this.store.tryAcquireLease(
        this.scope,
        this.ownerId,
        now,
        now + this.leaseMs,
      );
      if (!ownsLease) {
        return;
      }
      const batch = await this.store.getHead(this.scope);
      if (
        !batch ||
        !isReliableBatchEnvelope(batch, this.validateItem) ||
        batch.status === "blocked"
      ) {
        if (batch && !isReliableBatchEnvelope(batch, this.validateItem)) {
          await this.scanMalformed();
        }
        return;
      }
      const controller = new AbortController();
      await this.sendBatch(cloneBatch(batch), {
        keepalive: true,
        signal: controller.signal,
        abort: (reason) => controller.abort(reason),
      });
      await this.store.acknowledge(this.scope, batch.id, this.ownerId);
    } catch (error) {
      // The transactional outbox remains authoritative for the next owner.
      await this.reportStorageFailure(error);
    } finally {
      this.shutdownFlushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.scheduled) {
      this.scheduler.cancel(this.scheduled.handle);
      this.scheduled = null;
    }
    this.activeController?.abort(new Error("Reliable batch queue closed"));
    await Promise.allSettled([...this.pendingEnqueues]);
    if (this.running) {
      await this.running;
    }
    await this.store.releaseLease(this.scope, this.ownerId);
  }

  private async enqueueInternal(items: T[]): Promise<ReliableBatchEnqueueResult<T>> {
    const clonedItems = structuredClone(items);
    const bytes = this.measureItems(clonedItems);
    const recoveryId = this.createId();
    if (this.closed) {
      return {
        accepted: false,
        recoveryId,
        reason: "closed",
        items: clonedItems,
        bytes,
        stats: await this.safeStats(),
        limits: this.limits,
      };
    }
    const now = this.clock.now();
    const draft: ReliableBatchEnvelope<T> = {
      id: recoveryId,
      scope: this.scope,
      destination: this.destination,
      createdAt: now,
      items: clonedItems,
      bytes,
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
    };
    if (items.length > this.limits.maxBatchEvents || bytes > this.limits.maxBatchBytes) {
      const rejected: ReliableBatchEnqueueResult<T> = {
        accepted: false,
        recoveryId,
        reason: "batch_too_large",
        items: clonedItems,
        bytes,
        stats: await this.safeStats(),
        limits: this.limits,
      };
      this.reportRejected(rejected);
      return rejected;
    }
    try {
      const result = await this.store.enqueue(draft, this.limits);
      if (result.accepted) {
        this.wake();
      } else {
        this.reportRejected(result);
      }
      return result;
    } catch (error) {
      const stats = await this.safeStats();
      this.reportFailure({
        batchId: null,
        recoveryId,
        items: clonedItems,
        reason: "persistence",
        attempts: 0,
        error: toError(error),
        stats,
        limits: this.limits,
      });
      return {
        accepted: false,
        recoveryId,
        reason: "persistence",
        items: clonedItems,
        bytes,
        stats,
        limits: this.limits,
      };
    }
  }

  private reportRejected(
    result: Extract<ReliableBatchEnqueueResult<T>, { accepted: false }>,
  ): void {
    this.reportFailure({
      batchId: null,
      recoveryId: result.recoveryId,
      items: structuredClone(result.items),
      reason: result.reason === "capability_absent" ? "capability_absent" : "overflow",
      attempts: 0,
      error: new Error(
        result.reason === "batch_too_large"
          ? "Transcript batch exceeds the per-request outbox limit"
          : result.reason === "capability_absent"
            ? "Transcript batching is unavailable on this server"
            : "Transcript outbox capacity reached",
      ),
      stats: result.stats,
      limits: result.limits,
    });
  }

  private scheduleAt(at: number): void {
    if (this.closed) {
      return;
    }
    if (this.scheduled && this.scheduled.at <= at) {
      return;
    }
    if (this.scheduled) {
      this.scheduler.cancel(this.scheduled.handle);
    }
    const delay = Math.max(0, at - this.clock.now());
    const handle = this.scheduler.schedule(delay, () => {
      this.scheduled = null;
      this.running ??= this.run()
        .catch(async (error: unknown) => {
          await this.reportStorageFailure(error);
          this.scheduleAt(this.clock.now() + this.ownerRetryMs);
        })
        .finally(() => {
          this.running = null;
        });
    });
    this.scheduled = { handle, at };
  }

  private async run(): Promise<void> {
    if (this.closed || this.shutdownFlushing) {
      return;
    }
    const now = this.clock.now();
    const ownsLease = await this.store.tryAcquireLease(
      this.scope,
      this.ownerId,
      now,
      now + this.leaseMs,
    );
    if (!ownsLease) {
      this.scheduleAt(now + this.ownerRetryMs);
      return;
    }
    await this.scanMalformed();
    if (await this.store.isCapabilityAbsent(this.scope)) {
      this.scheduleAt(now + this.ownerRetryMs);
      return;
    }

    while (!this.closed && !this.shutdownFlushing) {
      const currentTime = this.clock.now();
      const renewed = await this.store.renewLease(
        this.scope,
        this.ownerId,
        currentTime,
        currentTime + this.leaseMs,
      );
      if (!renewed) {
        this.scheduleAt(currentTime + this.ownerRetryMs);
        return;
      }
      const batch = await this.store.getHead(this.scope);
      if (!batch) {
        this.scheduleAt(currentTime + Math.floor(this.leaseMs / 3));
        return;
      }
      if (!isReliableBatchEnvelope(batch, this.validateItem)) {
        await this.scanMalformed();
        this.scheduleAt(currentTime);
        return;
      }
      if (batch.status === "blocked") {
        await this.reportPersistedBlock(batch);
        this.scheduleAt(currentTime + Math.floor(this.leaseMs / 3));
        return;
      }
      if (batch.nextAttemptAt > currentTime) {
        this.scheduleAt(Math.min(batch.nextAttemptAt, currentTime + Math.floor(this.leaseMs / 3)));
        return;
      }

      const controller = new AbortController();
      this.activeController = controller;
      try {
        await this.sendBatch(cloneBatch(batch), {
          keepalive: false,
          signal: controller.signal,
          abort: (reason) => controller.abort(reason),
        });
        await this.store.acknowledge(this.scope, batch.id, this.ownerId);
        this.reportedFailures.delete(batch.id);
      } catch (error) {
        if (this.closed || this.shutdownFlushing) {
          return;
        }
        const normalized = toError(error);
        if (
          normalized instanceof ReliableBatchDeliveryError &&
          normalized.kind === "capability_absent"
        ) {
          await this.store.markCapabilityAbsentAndClear(this.scope);
          return;
        }
        const attempts = batch.attempts + 1;
        const isPermanent =
          normalized instanceof ReliableBatchDeliveryError && normalized.kind === "permanent";
        const exhausted = attempts >= this.maxAttempts;
        if (isPermanent || exhausted) {
          const reason = isPermanent ? "permanent" : "retries_exhausted";
          await this.store.recordFailure(this.scope, batch.id, this.ownerId, {
            attempts,
            nextAttemptAt: batch.nextAttemptAt,
            status: "blocked",
            failureReason: reason,
            lastError: normalized.message,
          });
          this.reportFailure({
            batchId: batch.id,
            recoveryId: null,
            items: batch.items,
            reason,
            attempts,
            error: normalized,
            stats: await this.safeStats(),
            limits: this.limits,
          });
          this.reportedFailures.add(batch.id);
          return;
        }
        const retryAfterMs =
          normalized instanceof ReliableBatchDeliveryError ? normalized.retryAfterMs : null;
        const delay = Math.max(
          0,
          this.retryDelayMs(attempts),
          retryAfterMs === null ? 0 : retryAfterMs,
        );
        const nextAttemptAt = this.clock.now() + delay;
        await this.store.recordFailure(this.scope, batch.id, this.ownerId, {
          attempts,
          nextAttemptAt,
          status: "pending",
          lastError: normalized.message,
        });
        this.scheduleAt(nextAttemptAt);
        return;
      } finally {
        if (this.activeController === controller) {
          this.activeController = null;
        }
      }
    }
  }

  private async reportPersistedBlock(batch: ReliableBatchEnvelope<T>): Promise<void> {
    if (this.reportedFailures.has(batch.id)) {
      return;
    }
    this.reportedFailures.add(batch.id);
    this.reportFailure({
      batchId: batch.id,
      recoveryId: null,
      items: batch.items,
      reason: batch.failureReason ?? "permanent",
      attempts: batch.attempts,
      error: new Error(batch.lastError ?? "Transcript delivery is blocked"),
      stats: await this.safeStats(),
      limits: this.limits,
    });
  }

  private async safeStats(): Promise<ReliableBatchStats> {
    try {
      return await this.store.stats(this.scope);
    } catch {
      return EMPTY_STATS;
    }
  }

  private async scanMalformed(): Promise<void> {
    const malformed = await this.store.quarantineMalformed(this.scope, (value) =>
      isReliableBatchEnvelope(value, this.validateItem),
    );
    for (const record of malformed) {
      this.reportFailure({
        batchId: record.id,
        recoveryId: null,
        items: [],
        reason: "malformed",
        attempts: 0,
        error: new Error(record.message),
        stats: await this.safeStats(),
        limits: this.limits,
      });
    }
  }

  private async reportStorageFailure(error: unknown): Promise<void> {
    this.reportFailure({
      batchId: null,
      recoveryId: null,
      items: [],
      reason: "persistence",
      attempts: 0,
      error: toError(error),
      stats: await this.safeStats(),
      limits: this.limits,
    });
  }

  private reportFailure(failure: ReliableBatchFailure<T>): void {
    try {
      this.onFailure?.({
        ...failure,
        items: structuredClone(failure.items),
      });
    } catch {
      // Failure reporting must never break outbox persistence or ownership.
    }
  }
}
