import { describe, expect, mock, test } from "bun:test";

import { PersistenceManager } from "../../src/server/session/PersistenceManager";
import type { PersistedSessionMutation, SessionDb } from "../../src/server/sessionDb";

function createPersistenceHarness(opts: {
  persistSessionMutation: (mutation: PersistedSessionMutation) => Promise<number>;
  persistSessionSnapshot: (sessionId: string, snapshot: unknown) => Promise<void>;
}) {
  const errors: string[] = [];
  const manager = new PersistenceManager({
    sessionId: "session-1",
    sessionDb: {
      persistSessionMutation: opts.persistSessionMutation,
      persistSessionSnapshot: opts.persistSessionSnapshot,
    } as SessionDb,
    getCoworkPaths: () => ({ sessionsDir: "/tmp/session-persistence" }) as never,
    writePersistedSessionSnapshot: async () => undefined,
    buildCanonicalSnapshot: () => ({}) as PersistedSessionMutation["snapshot"],
    buildPersistedSnapshotAt: () => ({}) as never,
    buildSessionSnapshotAt: (_updatedAt, lastEventSeq) => ({ lastEventSeq }) as never,
    emitTelemetry: () => {},
    emitError: (message) => {
      errors.push(message);
    },
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return { manager, errors };
}

describe("session snapshot persistence reliability", () => {
  test("retries a transient canonical-session write without dropping the accepted state", async () => {
    let attempts = 0;
    const persistSessionMutation = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("database is locked");
      return 7;
    });
    const persistSessionSnapshot = mock(async () => {});
    const { manager, errors } = createPersistenceHarness({
      persistSessionMutation,
      persistSessionSnapshot,
    });

    manager.queuePersistSessionSnapshot("session.user_message");
    await manager.waitForIdle({ throwOnError: true });

    expect(persistSessionMutation).toHaveBeenCalledTimes(2);
    expect(persistSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  test("retries a rich snapshot without writing the canonical mutation twice", async () => {
    const persistSessionMutation = mock(async () => 9);
    let snapshotAttempts = 0;
    const persistSessionSnapshot = mock(async () => {
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) throw new Error("snapshot writer temporarily unavailable");
    });
    const { manager } = createPersistenceHarness({
      persistSessionMutation,
      persistSessionSnapshot,
    });

    manager.queuePersistSessionSnapshot("session.workflow_completed");
    await manager.waitForIdle({ throwOnError: true });

    expect(persistSessionMutation).toHaveBeenCalledTimes(1);
    expect(persistSessionSnapshot).toHaveBeenCalledTimes(2);
    expect(persistSessionSnapshot).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({ lastEventSeq: 9 }),
    );
  });

  test("keeps exhausted mutation reasons pending until a later recovery succeeds", async () => {
    let failing = true;
    const persistSessionMutation = mock(async () => {
      if (failing) throw new Error("persistent database outage");
      return 11;
    });
    const persistSessionSnapshot = mock(async () => {});
    const { manager, errors } = createPersistenceHarness({
      persistSessionMutation,
      persistSessionSnapshot,
    });

    manager.queuePersistSessionSnapshot("session.user_message");
    await expect(manager.waitForIdle({ throwOnError: true })).rejects.toThrow(
      "persistent database outage",
    );
    expect(errors).toHaveLength(1);

    failing = false;
    manager.queuePersistSessionSnapshot("session.provider_recovered");
    await manager.waitForIdle({ throwOnError: true });

    const recoveredMutation = persistSessionMutation.mock.calls.at(-1)?.[0];
    expect(recoveredMutation?.payload).toMatchObject({
      reasons: ["session.user_message", "session.provider_recovered"],
    });
    expect(persistSessionSnapshot).toHaveBeenCalledTimes(1);
  });
});
