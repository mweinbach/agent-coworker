import { createThreadJournalNotificationProjector } from "../jsonrpc/threadJournalNotificationProjector";
import type { SessionEvent } from "../protocol";
import type { PersistedThreadJournalEvent, SessionDb } from "../sessionDb";
import type { SessionBinding } from "../startServer/types";

type ThreadJournalEvent = Omit<PersistedThreadJournalEvent, "seq">;

export class ThreadJournal {
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly pendingEvents = new Map<string, ThreadJournalEvent[]>();
  private readonly scheduledFlushes = new Set<string>();

  constructor(private readonly sessionDb: SessionDb) {}

  enqueue(event: ThreadJournalEvent): Promise<void> {
    const pending = this.pendingEvents.get(event.threadId) ?? [];
    pending.push(event);
    this.pendingEvents.set(event.threadId, pending);

    if (this.scheduledFlushes.has(event.threadId)) {
      return this.writeQueues.get(event.threadId) ?? Promise.resolve();
    }

    this.scheduledFlushes.add(event.threadId);
    const previous = this.writeQueues.get(event.threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Keep queue alive after prior failure.
      })
      .then(async () => {
        while (true) {
          const batch = this.pendingEvents.get(event.threadId) ?? [];
          if (batch.length === 0) {
            this.pendingEvents.delete(event.threadId);
            this.scheduledFlushes.delete(event.threadId);
            this.writeQueues.delete(event.threadId);
            return;
          }
          this.pendingEvents.set(event.threadId, []);
          await this.sessionDb.appendThreadJournalEvents(batch);
        }
      });
    this.writeQueues.set(event.threadId, next);
    return next;
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
