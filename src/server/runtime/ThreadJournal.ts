import { createThreadJournalNotificationProjector } from "../jsonrpc/threadJournalNotificationProjector";
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

export class ThreadJournal {
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly pendingEvents = new Map<string, ThreadJournalEvent[]>();
  private readonly scheduledFlushes = new Set<string>();
  private readonly failures = new Map<string, ThreadJournalFailureState>();
  private closed = false;

  constructor(private readonly sessionDb: SessionDb) {}

  enqueue(event: ThreadJournalEvent): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }

    const pending = this.pendingEvents.get(event.threadId) ?? [];
    pending.push(event);
    this.pendingEvents.set(event.threadId, pending);

    this.scheduleFlush(event.threadId);
    return this.writeQueues.get(event.threadId) ?? Promise.resolve();
  }

  private scheduleFlush(threadId: string): void {
    if (this.closed) {
      return;
    }

    if (this.scheduledFlushes.has(threadId)) {
      return;
    }

    this.scheduledFlushes.add(threadId);
    const previous = this.writeQueues.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Keep queue alive after prior failure.
      })
      .then(async () => {
        while (true) {
          const batch = this.pendingEvents.get(threadId) ?? [];
          if (batch.length === 0) {
            this.pendingEvents.delete(threadId);
            this.scheduledFlushes.delete(threadId);
            this.writeQueues.delete(threadId);
            return;
          }
          this.pendingEvents.set(threadId, []);
          try {
            await this.sessionDb.appendThreadJournalEvents(batch);
          } catch (error) {
            try {
              await this.recordFailure(threadId, batch.length, error);
            } catch {
              // Keep the original append failure as the caller-visible error.
            }
            this.scheduledFlushes.delete(threadId);
            this.writeQueues.delete(threadId);
            if (!this.closed && (this.pendingEvents.get(threadId)?.length ?? 0) > 0) {
              queueMicrotask(() => this.scheduleFlush(threadId));
            }
            throw error;
          }
        }
      });
    this.writeQueues.set(threadId, next);
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
    await (this.writeQueues.get(threadId) ?? Promise.resolve()).catch(() => {
      // Best-effort only.
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.writeQueues.values());
    this.pendingEvents.clear();
    this.scheduledFlushes.clear();
    this.writeQueues.clear();
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
    const pendingEventCount = this.pendingEvents.get(threadId)?.length ?? 0;
    const tailSeq = this.sessionDb.getThreadJournalTailSeq(threadId);
    return {
      trusted: !failure,
      failedWriteCount: failure?.failedWriteCount ?? 0,
      droppedEventCount: failure?.droppedEventCount ?? 0,
      pendingEventCount,
      pendingThreadCount: this.pendingEvents.size,
      lastFailureAt: failure?.lastFailureAt ?? null,
      lastFailureMessage: failure?.lastFailureMessage ?? null,
      tailSeq,
    };
  }

  /**
   * Cheap, process-wide journal health summary for the `/cowork/health`
   * endpoint. Unlike {@link getHealth}, this reads only the in-memory failure
   * and pending-event maps — no per-thread persisted-failure file reads — so it
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
    for (const events of this.pendingEvents.values()) {
      if (events.length > 0) {
        pendingThreadCount += 1;
        backlog += events.length;
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
    addBindingSink(binding, sinkId, (event) => projector.handle(event));
  }
}
