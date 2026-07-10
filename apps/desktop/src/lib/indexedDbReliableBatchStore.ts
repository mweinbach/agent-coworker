import type {
  ReliableBatchEnqueueResult,
  ReliableBatchEnvelope,
  ReliableBatchFailureUpdate,
  ReliableBatchLimits,
  ReliableBatchMalformedRecord,
  ReliableBatchStats,
  ReliableBatchStore,
} from "../../../../src/shared/reliableBatchQueue";

export const RELIABLE_BATCH_DB_NAME = "cowork-reliable-batch-outbox-v1";

const DB_VERSION = 1;
const BATCHES_STORE = "batches";
const SCOPES_STORE = "scopes";
const LEASES_STORE = "leases";
const DEAD_LETTERS_STORE = "deadLetters";
const GENERATIONS_STORE = "generations";
const SCOPE_ORDER_INDEX = "scopeOrder";
const CAPABILITY_REPROBE_MS = 60_000;

type ScopeRecord = ReliableBatchStats & {
  scope: string;
  capabilityAbsentUntil: number | null;
};

type LeaseRecord = {
  scope: string;
  ownerId: string;
  expiresAt: number;
};

type GenerationRecord = {
  scope: string;
  threadId: string;
  generation: number;
};

type DeadLetterRecord = {
  scope: string;
  batchId: string | null;
  quarantinedAt: number;
  message: string;
  value: unknown;
};

const EMPTY_STATS: ReliableBatchStats = {
  batches: 0,
  events: 0,
  bytes: 0,
};

function cloneStats(stats: ReliableBatchStats): ReliableBatchStats {
  return {
    batches: stats.batches,
    events: stats.events,
    bytes: stats.bytes,
  };
}

function defaultScopeRecord(scope: string): ScopeRecord {
  return {
    scope,
    capabilityAbsentUntil: null,
    ...EMPTY_STATS,
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function scopeRange(scope: string): IDBKeyRange {
  return IDBKeyRange.bound(
    [scope, Number.MIN_SAFE_INTEGER, ""],
    [scope, Number.MAX_SAFE_INTEGER, "\uffff"],
  );
}

function recordScope(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const scope = (value as { scope?: unknown }).scope;
  return typeof scope === "string" ? scope : null;
}

function recordId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function batchContribution(value: unknown): ReliableBatchStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_STATS;
  }
  const record = value as {
    items?: unknown;
    bytes?: unknown;
  };
  return {
    batches: 1,
    events: Array.isArray(record.items) ? record.items.length : 0,
    bytes:
      typeof record.bytes === "number" && Number.isSafeInteger(record.bytes) && record.bytes >= 0
        ? record.bytes
        : 0,
  };
}

function subtractContribution(scope: ScopeRecord, value: unknown): void {
  const contribution = batchContribution(value);
  scope.batches = Math.max(0, scope.batches - contribution.batches);
  scope.events = Math.max(0, scope.events - contribution.events);
  scope.bytes = Math.max(0, scope.bytes - contribution.bytes);
}

export class IndexedDbReliableBatchStore<T> implements ReliableBatchStore<T> {
  private readonly factory: IDBFactory;
  private readonly dbName: string;
  private readonly now: () => number;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: { factory: IDBFactory; dbName?: string; now?: () => number }) {
    this.factory = options.factory;
    this.dbName = options.dbName ?? RELIABLE_BATCH_DB_NAME;
    this.now = options.now ?? (() => Date.now());
  }

  async enqueue(
    batch: ReliableBatchEnvelope<T>,
    limits: ReliableBatchLimits,
  ): Promise<ReliableBatchEnqueueResult<T>> {
    const database = await this.database();
    const transaction = database.transaction([BATCHES_STORE, SCOPES_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const batches = transaction.objectStore(BATCHES_STORE);
    const scopes = transaction.objectStore(SCOPES_STORE);
    const scope =
      ((await requestResult(scopes.get(batch.scope))) as ScopeRecord | undefined) ??
      defaultScopeRecord(batch.scope);
    if (scope.capabilityAbsentUntil !== null && scope.capabilityAbsentUntil > this.now()) {
      transaction.abort();
      try {
        await completion;
      } catch {
        // An intentional abort keeps the capability marker unchanged.
      }
      return {
        accepted: false,
        reason: "capability_absent",
        items: structuredClone(batch.items),
        bytes: batch.bytes,
        stats: cloneStats(scope),
        limits,
      };
    }
    scope.capabilityAbsentUntil = null;
    const nextStats = {
      batches: scope.batches + 1,
      events: scope.events + batch.items.length,
      bytes: scope.bytes + batch.bytes,
    };
    if (
      nextStats.batches > limits.maxBatches ||
      nextStats.events > limits.maxEvents ||
      nextStats.bytes > limits.maxBytes
    ) {
      transaction.abort();
      try {
        await completion;
      } catch {
        // An intentional abort preserves every existing outbox record.
      }
      return {
        accepted: false,
        reason: "overflow",
        items: structuredClone(batch.items),
        bytes: batch.bytes,
        stats: cloneStats(scope),
        limits,
      };
    }
    batches.add(structuredClone(batch));
    scopes.put({
      ...scope,
      ...nextStats,
    } satisfies ScopeRecord);
    await completion;
    return {
      accepted: true,
      batch: structuredClone(batch),
      stats: nextStats,
    };
  }

  async getHead(scope: string): Promise<ReliableBatchEnvelope<T> | null> {
    const database = await this.database();
    const transaction = database.transaction(BATCHES_STORE, "readonly");
    const completion = transactionDone(transaction);
    const request = transaction
      .objectStore(BATCHES_STORE)
      .index(SCOPE_ORDER_INDEX)
      .openCursor(scopeRange(scope));
    const cursor = await requestResult(request);
    await completion;
    return cursor ? (structuredClone(cursor.value) as ReliableBatchEnvelope<T>) : null;
  }

  async list(scope: string): Promise<ReliableBatchEnvelope<T>[]> {
    const database = await this.database();
    const transaction = database.transaction(BATCHES_STORE, "readonly");
    const completion = transactionDone(transaction);
    const values = await requestResult(
      transaction.objectStore(BATCHES_STORE).index(SCOPE_ORDER_INDEX).getAll(scopeRange(scope)),
    );
    await completion;
    return (values as ReliableBatchEnvelope<T>[]).map((batch) => structuredClone(batch));
  }

  async stats(scope: string): Promise<ReliableBatchStats> {
    const database = await this.database();
    const transaction = database.transaction(SCOPES_STORE, "readonly");
    const completion = transactionDone(transaction);
    const record = (await requestResult(transaction.objectStore(SCOPES_STORE).get(scope))) as
      | ScopeRecord
      | undefined;
    await completion;
    return record ? cloneStats(record) : cloneStats(EMPTY_STATS);
  }

  async acknowledge(scope: string, batchId: string, ownerId: string): Promise<boolean> {
    return await this.removeOwnedBatch(scope, batchId, ownerId);
  }

  async recordFailure(
    scope: string,
    batchId: string,
    ownerId: string,
    update: ReliableBatchFailureUpdate,
  ): Promise<boolean> {
    const database = await this.database();
    const transaction = database.transaction([BATCHES_STORE, LEASES_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const lease = (await requestResult(transaction.objectStore(LEASES_STORE).get(scope))) as
      | LeaseRecord
      | undefined;
    if (lease?.ownerId !== ownerId) {
      transaction.abort();
      try {
        await completion;
      } catch {
        // Losing ownership makes the in-flight result advisory only.
      }
      return false;
    }
    const batches = transaction.objectStore(BATCHES_STORE);
    const batch = (await requestResult(batches.get([scope, batchId]))) as
      | ReliableBatchEnvelope<T>
      | undefined;
    if (!batch) {
      await completion;
      return false;
    }
    batches.put({
      ...batch,
      ...update,
    } satisfies ReliableBatchEnvelope<T>);
    await completion;
    return true;
  }

  async retry(scope: string, batchId?: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(BATCHES_STORE, "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(BATCHES_STORE);
    const batches = batchId
      ? ([await requestResult(store.get([scope, batchId]))].filter(
          Boolean,
        ) as ReliableBatchEnvelope<T>[])
      : ((await requestResult(
          store.index(SCOPE_ORDER_INDEX).getAll(scopeRange(scope)),
        )) as ReliableBatchEnvelope<T>[]);
    for (const batch of batches) {
      store.put({
        ...batch,
        attempts: 0,
        nextAttemptAt: this.now(),
        status: "pending",
        failureReason: undefined,
        lastError: undefined,
      } satisfies ReliableBatchEnvelope<T>);
    }
    await completion;
  }

  async discard(scope: string, batchId: string): Promise<void> {
    await this.removeBatch(scope, batchId);
    const database = await this.database();
    const transaction = database.transaction(DEAD_LETTERS_STORE, "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(DEAD_LETTERS_STORE);
    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value as Partial<DeadLetterRecord>;
        if (record.scope === scope && record.batchId === batchId) {
          cursor.delete();
        }
        cursor.continue();
      };
    });
    await completion;
  }

  async tryAcquireLease(
    scope: string,
    ownerId: string,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    const database = await this.database();
    const transaction = database.transaction(LEASES_STORE, "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(LEASES_STORE);
    const lease = (await requestResult(store.get(scope))) as LeaseRecord | undefined;
    const acquired = !lease || lease.ownerId === ownerId || lease.expiresAt <= now;
    if (acquired) {
      store.put({ scope, ownerId, expiresAt } satisfies LeaseRecord);
    }
    await completion;
    return acquired;
  }

  async renewLease(
    scope: string,
    ownerId: string,
    _now: number,
    expiresAt: number,
  ): Promise<boolean> {
    const database = await this.database();
    const transaction = database.transaction(LEASES_STORE, "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(LEASES_STORE);
    const lease = (await requestResult(store.get(scope))) as LeaseRecord | undefined;
    const renewed = lease?.ownerId === ownerId;
    if (renewed) {
      store.put({ scope, ownerId, expiresAt } satisfies LeaseRecord);
    }
    await completion;
    return renewed;
  }

  async releaseLease(scope: string, ownerId: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(LEASES_STORE, "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(LEASES_STORE);
    const lease = (await requestResult(store.get(scope))) as LeaseRecord | undefined;
    if (lease?.ownerId === ownerId) {
      store.delete(scope);
    }
    await completion;
  }

  async isCapabilityAbsent(scope: string): Promise<boolean> {
    const database = await this.database();
    const transaction = database.transaction(SCOPES_STORE, "readonly");
    const completion = transactionDone(transaction);
    const record = (await requestResult(transaction.objectStore(SCOPES_STORE).get(scope))) as
      | ScopeRecord
      | undefined;
    await completion;
    return (
      typeof record?.capabilityAbsentUntil === "number" && record.capabilityAbsentUntil > this.now()
    );
  }

  async markCapabilityAbsentAndClear(scope: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction([BATCHES_STORE, SCOPES_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const batchStore = transaction.objectStore(BATCHES_STORE);
    for (const batch of (await requestResult(
      batchStore.index(SCOPE_ORDER_INDEX).getAll(scopeRange(scope)),
    )) as ReliableBatchEnvelope<T>[]) {
      batchStore.delete([scope, batch.id]);
    }
    transaction.objectStore(SCOPES_STORE).put({
      ...defaultScopeRecord(scope),
      capabilityAbsentUntil: this.now() + CAPABILITY_REPROBE_MS,
    } satisfies ScopeRecord);
    await completion;
  }

  async quarantineMalformed(
    scope: string,
    validate: (value: unknown) => boolean,
  ): Promise<ReliableBatchMalformedRecord[]> {
    const database = await this.database();
    const transaction = database.transaction(
      [BATCHES_STORE, SCOPES_STORE, DEAD_LETTERS_STORE],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const batches = transaction.objectStore(BATCHES_STORE);
    const deadLetters = transaction.objectStore(DEAD_LETTERS_STORE);
    const scopes = transaction.objectStore(SCOPES_STORE);
    const scopeRecord =
      ((await requestResult(scopes.get(scope))) as ScopeRecord | undefined) ??
      defaultScopeRecord(scope);
    const malformed: ReliableBatchMalformedRecord[] = [];
    await new Promise<void>((resolve, reject) => {
      const request = batches.openCursor();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const value = cursor.value as unknown;
        if (recordScope(value) === scope && !validate(value)) {
          const id = recordId(value);
          malformed.push({
            id,
            message: "Malformed transcript outbox record was quarantined",
          });
          subtractContribution(scopeRecord, value);
          deadLetters.add({
            scope,
            batchId: id,
            quarantinedAt: this.now(),
            message: "Malformed transcript outbox record",
            value,
          } satisfies DeadLetterRecord);
          cursor.delete();
        }
        cursor.continue();
      };
    });
    scopes.put(scopeRecord);
    await completion;
    return malformed;
  }

  async getGeneration(scope: string, threadId: string): Promise<number> {
    const database = await this.database();
    const transaction = database.transaction(GENERATIONS_STORE, "readonly");
    const completion = transactionDone(transaction);
    const record = (await requestResult(
      transaction.objectStore(GENERATIONS_STORE).get([scope, threadId]),
    )) as GenerationRecord | undefined;
    await completion;
    return record?.generation ?? 0;
  }

  async incrementGenerationAndCancel(
    scope: string,
    threadId: string,
    matches: (item: T) => boolean,
  ): Promise<{ generation: number; removed: ReliableBatchStats }> {
    const database = await this.database();
    const transaction = database.transaction(
      [BATCHES_STORE, SCOPES_STORE, GENERATIONS_STORE],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const generations = transaction.objectStore(GENERATIONS_STORE);
    const current = (await requestResult(generations.get([scope, threadId]))) as
      | GenerationRecord
      | undefined;
    const generation = (current?.generation ?? 0) + 1;
    generations.put({ scope, threadId, generation } satisfies GenerationRecord);

    const batches = transaction.objectStore(BATCHES_STORE);
    const matching = (await requestResult(
      batches.index(SCOPE_ORDER_INDEX).getAll(scopeRange(scope)),
    )) as ReliableBatchEnvelope<T>[];
    const removed = cloneStats(EMPTY_STATS);
    const scopes = transaction.objectStore(SCOPES_STORE);
    const scopeRecord =
      ((await requestResult(scopes.get(scope))) as ScopeRecord | undefined) ??
      defaultScopeRecord(scope);
    for (const batch of matching) {
      if (!batch.items.some(matches)) {
        continue;
      }
      batches.delete([scope, batch.id]);
      const contribution = batchContribution(batch);
      removed.batches += contribution.batches;
      removed.events += contribution.events;
      removed.bytes += contribution.bytes;
      subtractContribution(scopeRecord, batch);
    }
    scopes.put(scopeRecord);
    await completion;
    return { generation, removed };
  }

  async close(): Promise<void> {
    if (!this.databasePromise) {
      return;
    }
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = null;
  }

  private async removeOwnedBatch(
    scope: string,
    batchId: string,
    ownerId: string,
  ): Promise<boolean> {
    const database = await this.database();
    const transaction = database.transaction(
      [BATCHES_STORE, SCOPES_STORE, LEASES_STORE],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const lease = (await requestResult(transaction.objectStore(LEASES_STORE).get(scope))) as
      | LeaseRecord
      | undefined;
    if (lease?.ownerId !== ownerId) {
      transaction.abort();
      try {
        await completion;
      } catch {
        // Losing ownership prevents an old sender from deleting shared data.
      }
      return false;
    }
    const removed = await this.removeBatchInTransaction(transaction, scope, batchId);
    await completion;
    return removed;
  }

  private async removeBatch(scope: string, batchId: string): Promise<boolean> {
    const database = await this.database();
    const transaction = database.transaction([BATCHES_STORE, SCOPES_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const removed = await this.removeBatchInTransaction(transaction, scope, batchId);
    await completion;
    return removed;
  }

  private async removeBatchInTransaction(
    transaction: IDBTransaction,
    scope: string,
    batchId: string,
  ): Promise<boolean> {
    const batches = transaction.objectStore(BATCHES_STORE);
    const batch = (await requestResult(batches.get([scope, batchId]))) as
      | ReliableBatchEnvelope<T>
      | undefined;
    if (!batch) {
      return false;
    }
    batches.delete([scope, batchId]);
    const scopes = transaction.objectStore(SCOPES_STORE);
    const scopeRecord =
      ((await requestResult(scopes.get(scope))) as ScopeRecord | undefined) ??
      defaultScopeRecord(scope);
    subtractContribution(scopeRecord, batch);
    scopes.put(scopeRecord);
    return true;
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.dbName, DB_VERSION);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade was blocked"));
      request.onupgradeneeded = () => {
        const database = request.result;
        const batches = database.createObjectStore(BATCHES_STORE, {
          keyPath: ["scope", "id"],
        });
        batches.createIndex(SCOPE_ORDER_INDEX, ["scope", "createdAt", "id"], {
          unique: false,
        });
        database.createObjectStore(SCOPES_STORE, { keyPath: "scope" });
        database.createObjectStore(LEASES_STORE, { keyPath: "scope" });
        database.createObjectStore(DEAD_LETTERS_STORE, {
          keyPath: "quarantineId",
          autoIncrement: true,
        });
        database.createObjectStore(GENERATIONS_STORE, {
          keyPath: ["scope", "threadId"],
        });
      };
      request.onsuccess = () => resolve(request.result);
    });
    return this.databasePromise;
  }
}
