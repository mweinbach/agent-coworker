import { createThreadJournalNotificationProjector } from "../jsonrpc/threadJournalNotificationProjector";
import type { ConversationProjectionSeed } from "../projection/conversationProjection";
import type { SessionEvent } from "../protocol";
import type {
  PersistedThreadJournalEvent,
  PersistedThreadJournalFailure,
  SessionDb,
} from "../sessionDb";
import type { SessionBinding } from "../startServer/types";

type ThreadJournalEvent = Omit<PersistedThreadJournalEvent, "seq">;

export type ThreadJournalHealth = {
  trusted: boolean;
  failedWriteCount: number;
  droppedEventCount: number;
  pendingEventCount: number;
  pendingThreadCount: number;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  tailSeq: number;
};

type ThreadJournalFailureState = {
  failedWriteCount: number;
  droppedEventCount: number;
  lastFailureAt: string;
  lastFailureMessage: string;
};

type PendingThreadJournalEvent = {
  event: ThreadJournalEvent;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type ThreadJournalWriteQueue = {
  pending: PendingThreadJournalEvent[];
  inFlightEventCount: number;
  worker: Promise<void>;
};

export class ThreadJournal {
  private readonly writeQueues = new Map<string, ThreadJournalWriteQueue>();
  private readonly failures = new Map<string, ThreadJournalFailureState>();
  private projectorsByBinding = new WeakMap<
    SessionBinding,
    Map<string, ReturnType<typeof createThreadJournalNotificationProjector>>
  >();
  private closed: boolean = false;

  constructor(private readonly sessionDb: SessionDb) {}

  enqueue(event: ThreadJournalEvent): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const pending = { event, resolve, reject };
    const existing = this.writeQueues.get(event.threadId);
    if (existing) {
      existing.pending.push(pending);
      return promise;
    }

    const queue: ThreadJournalWriteQueue = {
      pending: [pending],
      inFlightEventCount: 0,
      worker: Promise.resolve(),
    };
    this.writeQueues.set(event.threadId, queue);
    queue.worker = Promise.resolve().then(() => this.flushQueue(event.threadId, queue));
    return promise;
  }

  private async flushQueue(threadId: string, queue: ThreadJournalWriteQueue): Promise<void> {
    while (queue.pending.length > 0) {
      let batch = queue.pending;
      queue.pending = [];
      queue.inFlightEventCount = batch.length;
      try {
        await this.sessionDb.appendThreadJournalEvents(batch.map((entry) => entry.event));
        for (const entry of batch) entry.resolve();
      } catch (error) {
        if (this.closed) {
          // A shutdown write failure also rejects queued work without starting another append.
          batch = batch.concat(queue.pending);
          queue.pending = [];
          queue.inFlightEventCount = batch.length;
        }
        try {
          await this.recordFailure(threadId, batch.length, error);
        } catch {
          // Keep the original append failure as the caller-visible error.
        }
        for (const entry of batch) entry.reject(error);
      } finally {
        queue.inFlightEventCount = 0;
      }
    }
    this.writeQueues.delete(threadId);
  }

  private readPersistedFailure(threadId: string): ThreadJournalFailureState | null {
    const readFailure = (this.sessionDb as Partial<Pick<SessionDb, "getThreadJournalFailure">>)
      .getThreadJournalFailure;
    const persisted = readFailure?.call(this.sessionDb, threadId) ?? null;
    if (!persisted) return null;
    return {
      failedWriteCount: persisted.failedWriteCount,
      droppedEventCount: persisted.droppedEventCount,
      lastFailureAt: persisted.lastFailureAt,
      lastFailureMessage: persisted.lastFailureMessage,
    };
  }

  private async persistFailure(
    threadId: string,
    failure: ThreadJournalFailureState,
  ): Promise<void> {
    const writeFailure = (this.sessionDb as Partial<Pick<SessionDb, "recordThreadJournalFailure">>)
      .recordThreadJournalFailure;
    if (!writeFailure) return;
    const input: PersistedThreadJournalFailure = {
      threadId,
      ...failure,
    };
    await writeFailure.call(this.sessionDb, input);
  }

  private async recordFailure(
    threadId: string,
    droppedEventCount: number,
    error: unknown,
  ): Promise<void> {
    const previous = this.failures.get(threadId) ?? this.readPersistedFailure(threadId);
    const next = {
      failedWriteCount: (previous?.failedWriteCount ?? 0) + 1,
      droppedEventCount: (previous?.droppedEventCount ?? 0) + droppedEventCount,
      lastFailureAt: new Date().toISOString(),
      lastFailureMessage: error instanceof Error ? error.message : String(error),
    };
    this.failures.set(threadId, next);
    await this.persistFailure(threadId, next);
  }

  async waitForIdle(threadId: string): Promise<void> {
    let queue = this.writeQueues.get(threadId);
    while (queue) {
      await queue.worker;
      queue = this.writeQueues.get(threadId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.projectorsByBinding = new WeakMap();
    await Promise.all(Array.from(this.writeQueues.values(), (queue) => queue.worker));
  }

  list(
    threadId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): PersistedThreadJournalEvent[] {
    return this.sessionDb.listThreadJournalEvents(threadId, opts);
  }

  getHealth(threadId: string): ThreadJournalHealth {
    const failure = this.failures.get(threadId) ?? this.readPersistedFailure(threadId);
    if (failure && !this.failures.has(threadId)) {
      this.failures.set(threadId, failure);
    }
    const queue = this.writeQueues.get(threadId);
    const pendingEventCount = queue ? queue.pending.length + queue.inFlightEventCount : 0;
    const tailSeq = this.sessionDb.getThreadJournalTailSeq(threadId);
    return {
      trusted: !failure,
      failedWriteCount: failure?.failedWriteCount ?? 0,
      droppedEventCount: failure?.droppedEventCount ?? 0,
      pendingEventCount,
      pendingThreadCount: this.writeQueues.size,
      lastFailureAt: failure?.lastFailureAt ?? null,
      lastFailureMessage: failure?.lastFailureMessage ?? null,
      tailSeq,
    };
  }

  /**
   * Cheap, process-wide journal health summary for the `/cowork/health`
   * endpoint. Unlike {@link getHealth}, this reads only the in-memory failure
   * and write-queue maps — no per-thread persisted-failure file reads — so it
   * stays O(active threads) and safe to hit on a fast polling loop.
   */
  getAggregateHealth(): {
    healthy: boolean;
    backlog: number;
    failedWriteCount: number;
    droppedEventCount: number;
    pendingThreadCount: number;
  } {
    let failedWriteCount = 0;
    let droppedEventCount = 0;
    for (const failure of this.failures.values()) {
      failedWriteCount += failure.failedWriteCount;
      droppedEventCount += failure.droppedEventCount;
    }
    let backlog = 0;
    let pendingThreadCount = 0;
    for (const queue of this.writeQueues.values()) {
      const eventCount = queue.pending.length + queue.inFlightEventCount;
      if (eventCount > 0) {
        pendingThreadCount += 1;
        backlog += eventCount;
      }
    }
    return {
      healthy: failedWriteCount === 0 && droppedEventCount === 0,
      backlog,
      failedWriteCount,
      droppedEventCount,
      pendingThreadCount,
    };
  }

  ensureSink(
    binding: SessionBinding,
    threadId: string,
    addBindingSink: (
      binding: SessionBinding,
      sinkId: string,
      sink: (event: SessionEvent) => void,
    ) => void,
  ): void {
    if (this.closed) return;
    const sinkId = `journal:${threadId}`;
    if (binding.sinks.has(sinkId)) {
      return;
    }
    const projector = createThreadJournalNotificationProjector({
      threadId,
      emit: (event) => {
        void this.enqueue(event).catch(() => {
          // Best-effort journal persistence; session snapshots remain authoritative fallback state.
        });
      },
    });
    let projectors = this.projectorsByBinding.get(binding);
    if (!projectors) {
      projectors = new Map();
      this.projectorsByBinding.set(binding, projectors);
    }
    projectors.set(threadId, projector);
    addBindingSink(binding, sinkId, (event) => projector.handle(event));
  }

  captureProjectionSeed(
    binding: SessionBinding,
    threadId: string,
  ): ConversationProjectionSeed | undefined {
    if (!binding.sinks.has(`journal:${threadId}`)) return undefined;
    return this.projectorsByBinding.get(binding)?.get(threadId)?.captureSeed();
  }

  flushProjection(binding: SessionBinding, threadId: string): void {
    if (!binding.sinks.has(`journal:${threadId}`)) return;
    this.projectorsByBinding.get(binding)?.get(threadId)?.flush();
  }
}
