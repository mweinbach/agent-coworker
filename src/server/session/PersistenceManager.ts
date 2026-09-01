import type { AiCoworkerPaths } from "../../connect";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { PersistedSessionMutation, SessionDb } from "../sessionDb";
import type { PersistedSessionSnapshot } from "../sessionStore";

const MAX_SNAPSHOT_PERSIST_ATTEMPTS = 3;
const SNAPSHOT_PERSIST_RETRY_DELAY_MS = 10;

type PendingCanonicalSnapshot = {
  primaryReason: string;
  reasons: string[];
  revision: number;
  updatedAt: string;
  lastEventSeq: number;
  snapshot: SessionSnapshot;
};

export class PersistenceManager {
  private queue: Promise<void> = Promise.resolve();
  private pendingReasons = new Map<string, number>();
  private requestedRevision = 0;
  private pendingCanonicalSnapshot: PendingCanonicalSnapshot | null = null;
  private flushQueued = false;
  private lastError: unknown = null;

  constructor(
    private readonly opts: {
      sessionId: string;
      persistenceEnabled?: boolean;
      sessionDb: SessionDb | null;
      getCoworkPaths: () => AiCoworkerPaths;
      writePersistedSessionSnapshot: (opts: {
        paths: Pick<AiCoworkerPaths, "sessionsDir">;
        snapshot: PersistedSessionSnapshot;
      }) => Promise<string | undefined>;
      buildCanonicalSnapshot: (updatedAt: string) => PersistedSessionMutation["snapshot"];
      buildPersistedSnapshotAt: (updatedAt: string) => PersistedSessionSnapshot;
      buildSessionSnapshotAt: (updatedAt: string, lastEventSeq: number) => SessionSnapshot;
      onPersistedLastEventSeq?: (lastEventSeq: number) => void;
      emitTelemetry: (
        name: string,
        status: "ok" | "error",
        attributes?: Record<string, string | number | boolean>,
        durationMs?: number,
      ) => void;
      emitError: (message: string) => void;
      formatError: (err: unknown) => string;
    },
  ) {}

  queuePersistSessionSnapshot(reason: string) {
    if (this.opts.persistenceEnabled === false) {
      return;
    }
    this.pendingReasons.set(reason, ++this.requestedRevision);
    if (this.flushQueued) {
      return;
    }
    this.flushQueued = true;

    const run = async () => {
      try {
        while (this.pendingReasons.size > 0) {
          const reasons = this.pendingReasons;
          this.pendingReasons = new Map();
          try {
            await this.persistReasons(reasons);
          } catch (error) {
            this.pendingReasons = new Map([...reasons, ...this.pendingReasons]);
            throw error;
          }
        }
        this.lastError = null;
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
        this.lastError = err;
        const formattedError = this.opts.formatError(err);
        this.opts.emitTelemetry("session.snapshot.persist", "error", {
          sessionId: this.opts.sessionId,
          reason,
          error: formattedError,
        });
        if (formattedError.toLowerCase().includes("database is locked")) {
          this.opts.emitTelemetry("session.db.sqlite_lock", "error", {
            sessionId: this.opts.sessionId,
            reason,
            error: formattedError,
          });
        }
        this.opts.emitError(`Failed to persist session state: ${formattedError}`);
      });
  }

  private async persistReasons(reasons: Map<string, number>): Promise<void> {
    const pendingCanonicalSnapshot = this.pendingCanonicalSnapshot;
    if (pendingCanonicalSnapshot) {
      await this.persistReasonBatch(
        pendingCanonicalSnapshot.primaryReason,
        pendingCanonicalSnapshot.reasons,
        pendingCanonicalSnapshot.revision,
      );

      // Reason labels describe updates; they do not identify them. A newer
      // update with the same label still needs its own canonical checkpoint.
      for (const [reason, revision] of reasons) {
        if (revision <= pendingCanonicalSnapshot.revision) reasons.delete(reason);
      }
      if (reasons.size === 0) return;
    }

    const reasonLabels = [...reasons.keys()];
    const primaryReason = reasonLabels.at(-1);
    if (primaryReason === undefined) return;
    await this.persistReasonBatch(primaryReason, reasonLabels, Math.max(...reasons.values()));
  }

  private async persistReasonBatch(
    primaryReason: string,
    reasons: string[],
    revision: number,
  ): Promise<void> {
    const startedAt = Date.now();
    const updatedAt = this.pendingCanonicalSnapshot?.updatedAt ?? new Date().toISOString();

    for (let attempt = 1; attempt <= MAX_SNAPSHOT_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        if (this.opts.sessionDb) {
          let pendingCanonicalSnapshot = this.pendingCanonicalSnapshot;
          if (!pendingCanonicalSnapshot) {
            const canonicalSnapshot = this.opts.buildCanonicalSnapshot(updatedAt);
            const snapshot = this.opts.buildSessionSnapshotAt(updatedAt, 0);
            const lastEventSeq = await this.opts.sessionDb.persistSessionMutation({
              sessionId: this.opts.sessionId,
              eventType: primaryReason,
              eventTs: updatedAt,
              direction: "system",
              payload: { reason: primaryReason, reasons },
              snapshot: canonicalSnapshot,
            });
            snapshot.lastEventSeq = lastEventSeq;
            pendingCanonicalSnapshot = {
              primaryReason,
              reasons: [...reasons],
              revision,
              updatedAt,
              lastEventSeq,
              snapshot,
            };
            this.pendingCanonicalSnapshot = pendingCanonicalSnapshot;
          }
          await this.opts.sessionDb.persistSessionSnapshot(
            this.opts.sessionId,
            pendingCanonicalSnapshot.snapshot,
          );
          this.opts.onPersistedLastEventSeq?.(pendingCanonicalSnapshot.lastEventSeq);
          this.pendingCanonicalSnapshot = null;
        } else {
          await this.opts.writePersistedSessionSnapshot({
            paths: this.opts.getCoworkPaths(),
            snapshot: this.opts.buildPersistedSnapshotAt(updatedAt),
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
          Date.now() - startedAt,
        );
        return;
      } catch (error) {
        if (attempt === MAX_SNAPSHOT_PERSIST_ATTEMPTS) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * SNAPSHOT_PERSIST_RETRY_DELAY_MS),
        );
      }
    }
  }

  async waitForIdle(opts: { throwOnError?: boolean } = {}) {
    while (true) {
      const pending = this.queue;
      await pending.catch(() => {});
      if (pending === this.queue) break;
    }
    if (opts.throwOnError && this.lastError) {
      throw this.lastError;
    }
  }

  getProjectedLastEventSeq(persistedLastEventSeq: number): number {
    if (this.flushQueued || this.pendingReasons.size > 0) {
      return persistedLastEventSeq + 1;
    }
    return persistedLastEventSeq;
  }
}
