import type { AiCoworkerPaths } from "../../connect";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { PersistedSessionMutation, SessionDb } from "../sessionDb";
import type { PersistedSessionSnapshot } from "../sessionStore";

export class PersistenceManager {
  private queue: Promise<void> = Promise.resolve();
  private pendingReasons = new Set<string>();
  private flushQueued = false;

  constructor(
    private readonly opts: {
      sessionId: string;
      persistenceEnabled?: boolean;
      sessionDb: SessionDb | null;
      getCoworkPaths: () => AiCoworkerPaths;
      writePersistedSessionSnapshot: (opts: {
        paths: Pick<AiCoworkerPaths, "sessionsDir">;
        snapshot: PersistedSessionSnapshot;
      }) => Promise<string | void>;
      buildCanonicalSnapshot: (updatedAt: string) => PersistedSessionMutation["snapshot"];
      buildPersistedSnapshotAt: (updatedAt: string) => PersistedSessionSnapshot;
      buildSessionSnapshotAt: (updatedAt: string, lastEventSeq: number) => SessionSnapshot;
      onPersistedLastEventSeq?: (lastEventSeq: number) => void;
      emitTelemetry: (
        name: string,
        status: "ok" | "error",
        attributes?: Record<string, string | number | boolean>,
        durationMs?: number
      ) => void;
      emitError: (message: string) => void;
      formatError: (err: unknown) => string;
    }
  ) {}

  queuePersistSessionSnapshot(reason: string) {
    if (this.opts.persistenceEnabled === false) {
      return;
    }
    this.pendingReasons.add(reason);
    if (this.flushQueued) {
      return;
    }
    this.flushQueued = true;

    const run = async () => {
      try {
        while (this.pendingReasons.size > 0) {
          const startedAt = Date.now();
          const updatedAt = new Date().toISOString();
          const reasons = [...this.pendingReasons];
          this.pendingReasons.clear();
          const primaryReason = reasons.at(-1) ?? reason;
          if (this.opts.sessionDb) {
            const lastEventSeq = await this.opts.sessionDb.persistSessionMutation({
              sessionId: this.opts.sessionId,
              eventType: primaryReason,
              eventTs: updatedAt,
              direction: "system",
              payload: { reason: primaryReason, reasons },
              snapshot: this.opts.buildCanonicalSnapshot(updatedAt),
            });
            await this.opts.sessionDb.persistSessionSnapshot(
              this.opts.sessionId,
              this.opts.buildSessionSnapshotAt(updatedAt, lastEventSeq),
            );
            this.opts.onPersistedLastEventSeq?.(lastEventSeq);
          } else {
            const snapshot = this.opts.buildPersistedSnapshotAt(updatedAt);
            await this.opts.writePersistedSessionSnapshot({
              paths: this.opts.getCoworkPaths(),
              snapshot,
            });
          }
          this.opts.emitTelemetry(
            "session.snapshot.persist",
            "ok",
            {
              sessionId: this.opts.sessionId,
              reason: primaryReason,
              coalescedReasonCount: reasons.length,
            },
            Date.now() - startedAt
          );
        }
      } finally {
        this.flushQueued = false;
      }
    };

    this.queue = this.queue
      .catch(() => {
        // keep queue alive after prior failures
      })
      .then(run)
      .catch((err) => {
        const formattedError = this.opts.formatError(err);
        this.opts.emitTelemetry(
          "session.snapshot.persist",
          "error",
          { sessionId: this.opts.sessionId, reason, error: formattedError }
        );
        if (formattedError.toLowerCase().includes("database is locked")) {
          this.opts.emitTelemetry("session.db.sqlite_lock", "error", {
            sessionId: this.opts.sessionId,
            reason,
            error: formattedError,
          });
        }
        this.opts.emitError(`Failed to persist session state: ${formattedError}`);
        if (this.pendingReasons.size > 0 && !this.flushQueued) {
          this.queuePersistSessionSnapshot([...this.pendingReasons].at(-1) ?? reason);
        }
      });
  }

  async waitForIdle() {
    await this.queue.catch(() => {});
  }

  getProjectedLastEventSeq(persistedLastEventSeq: number): number {
    if (this.flushQueued || this.pendingReasons.size > 0) {
      return persistedLastEventSeq + 1;
    }
    return persistedLastEventSeq;
  }
}
