import type { AiCoworkerPaths } from "../../connect";
import type { PersistedSessionMutation, SessionDb } from "../sessionDb";
import type { PersistedSessionSnapshot } from "../sessionStore";

export class PersistenceManager {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      sessionId: string;
      sessionDb: SessionDb | null;
      getCoworkPaths: () => AiCoworkerPaths;
      writePersistedSessionSnapshot: (opts: {
        paths: Pick<AiCoworkerPaths, "sessionsDir">;
        snapshot: PersistedSessionSnapshot;
      }) => Promise<string | void>;
      buildCanonicalSnapshot: (updatedAt: string) => PersistedSessionMutation["snapshot"];
      buildPersistedSnapshotAt: (updatedAt: string) => PersistedSessionSnapshot;
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
    const run = async () => {
      const startedAt = Date.now();
      const updatedAt = new Date().toISOString();
      if (this.opts.sessionDb) {
        this.opts.sessionDb.persistSessionMutation({
          sessionId: this.opts.sessionId,
          eventType: reason,
          eventTs: updatedAt,
          direction: "system",
          payload: { reason },
          snapshot: this.opts.buildCanonicalSnapshot(updatedAt),
        });
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
        { sessionId: this.opts.sessionId, reason },
        Date.now() - startedAt
      );
    };

    this.queue = this.queue
      .catch(() => {
        // keep queue alive after prior failures
      })
      .then(run)
      .catch((err) => {
        this.opts.emitTelemetry(
          "session.snapshot.persist",
          "error",
          { sessionId: this.opts.sessionId, reason, error: this.opts.formatError(err) }
        );
        this.opts.emitError(`Failed to persist session state: ${this.opts.formatError(err)}`);
      });
  }

  async waitForIdle() {
    await this.queue.catch(() => {});
  }
}
