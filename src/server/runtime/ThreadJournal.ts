import { createThreadJournalNotificationProjector } from "../jsonrpc/threadJournalNotificationProjector";
import type { SessionEvent } from "../protocol";
import type { PersistedThreadJournalEvent, SessionDb } from "../sessionDb";
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

  constructor(private readonly sessionDb: SessionDb) {}

  enqueue(event: ThreadJournalEvent): Promise<void> {
    const pending = this.pendingEvents.get(event.threadId) ?? [];
    pending.push(event);
    this.pendingEvents.set(event.threadId, pending);

    this.scheduleFlush(event.threadId);
    return this.writeQueues.get(event.threadId) ?? Promise.resolve();
  }

  private scheduleFlush(threadId: string): void {
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
            this.recordFailure(threadId, batch.length, error);
            this.scheduledFlushes.delete(threadId);
            this.writeQueues.delete(threadId);
            if ((this.pendingEvents.get(threadId)?.length ?? 0) > 0) {
              queueMicrotask(() => this.scheduleFlush(threadId));
            }
            throw error;
          }
        }
      });
    this.writeQueues.set(threadId, next);
  }

  private recordFailure(threadId: string, droppedEventCount: number, error: unknown): void {
    const previous = this.failures.get(threadId);
    this.failures.set(threadId, {
      failedWriteCount: (previous?.failedWriteCount ?? 0) + 1,
      droppedEventCount: (previous?.droppedEventCount ?? 0) + droppedEventCount,
      lastFailureAt: new Date().toISOString(),
      lastFailureMessage: error instanceof Error ? error.message : String(error),
    });
  }

  async waitForIdle(threadId: string): Promise<void> {
    await (this.writeQueues.get(threadId) ?? Promise.resolve()).catch(() => {
      // Best-effort only.
    });
  }

  list(
    threadId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): PersistedThreadJournalEvent[] {
    return this.sessionDb.listThreadJournalEvents(threadId, opts);
  }

  getHealth(threadId: string): ThreadJournalHealth {
    const failure = this.failures.get(threadId);
    const pendingEventCount = this.pendingEvents.get(threadId)?.length ?? 0;
    const tailSeq = this.list(threadId).at(-1)?.seq ?? 0;
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
