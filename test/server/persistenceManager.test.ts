import { describe, expect, mock, test } from "bun:test";

import { PersistenceManager } from "../../src/server/session/PersistenceManager";
import type { PersistedSessionMutation, SessionDb } from "../../src/server/sessionDb";

function createPersistenceHarness(opts: {
  persistSessionMutation: (mutation: PersistedSessionMutation) => Promise<number>;
  persistSessionSnapshot: (sessionId: string, snapshot: unknown) => Promise<void>;
  buildCanonicalSnapshot?: (updatedAt: string) => PersistedSessionMutation["snapshot"];
  buildSessionSnapshotAt?: (updatedAt: string, lastEventSeq: number) => unknown;
  onPersistedLastEventSeq?: (lastEventSeq: number) => void;
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
    buildCanonicalSnapshot:
      opts.buildCanonicalSnapshot ?? (() => ({}) as PersistedSessionMutation["snapshot"]),
    buildPersistedSnapshotAt: () => ({}) as never,
    buildSessionSnapshotAt: (updatedAt, lastEventSeq) =>
      (opts.buildSessionSnapshotAt?.(updatedAt, lastEventSeq) ?? { lastEventSeq }) as never,
    onPersistedLastEventSeq: opts.onPersistedLastEventSeq,
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

  test("resumes an exhausted rich snapshot before separately persisting newer canonical state", async () => {
    let state = "accepted";
    let snapshotUnavailable = true;
    let lastSeq = 20;
    const persistedSnapshots: Array<{ lastEventSeq: number; state: string }> = [];
    const observedSeqs: number[] = [];
    const persistSessionMutation = mock(async () => ++lastSeq);
    const persistSessionSnapshot = mock(async (_sessionId: string, snapshot: unknown) => {
      if (snapshotUnavailable) throw new Error("rich snapshot unavailable");
      persistedSnapshots.push(snapshot as { lastEventSeq: number; state: string });
    });
    const { manager } = createPersistenceHarness({
      persistSessionMutation,
      persistSessionSnapshot,
      buildCanonicalSnapshot: () => ({ state }) as never,
      buildSessionSnapshotAt: (_updatedAt, lastEventSeq) => ({ lastEventSeq, state }),
      onPersistedLastEventSeq: (lastEventSeq) => observedSeqs.push(lastEventSeq),
    });

    manager.queuePersistSessionSnapshot("session.user_message");
    await expect(manager.waitForIdle({ throwOnError: true })).rejects.toThrow(
      "rich snapshot unavailable",
    );
    expect(persistSessionMutation).toHaveBeenCalledTimes(1);
    expect(persistSessionSnapshot).toHaveBeenCalledTimes(3);

    state = "resolved";
    snapshotUnavailable = false;
    manager.queuePersistSessionSnapshot("session.approval_resolved");
    await manager.waitForIdle({ throwOnError: true });

    expect(persistSessionMutation).toHaveBeenCalledTimes(2);
    expect(persistSessionMutation.mock.calls.map(([mutation]) => mutation.eventType)).toEqual([
      "session.user_message",
      "session.approval_resolved",
    ]);
    expect(persistSessionMutation.mock.calls.map(([mutation]) => mutation.payload)).toEqual([
      { reason: "session.user_message", reasons: ["session.user_message"] },
      { reason: "session.approval_resolved", reasons: ["session.approval_resolved"] },
    ]);
    expect(persistedSnapshots).toEqual([
      { lastEventSeq: 21, state: "accepted" },
      { lastEventSeq: 22, state: "resolved" },
    ]);
    expect(observedSeqs).toEqual([21, 22]);
  });

  test("reuses an exhausted canonical checkpoint when its original reason is retried", async () => {
    let snapshotUnavailable = true;
    const persistSessionMutation = mock(async () => 14);
    const persistSessionSnapshot = mock(async () => {
      if (snapshotUnavailable) throw new Error("snapshot storage offline");
    });
    const { manager } = createPersistenceHarness({
      persistSessionMutation,
      persistSessionSnapshot,
    });

    manager.queuePersistSessionSnapshot("session.workflow_completed");
    await expect(manager.waitForIdle({ throwOnError: true })).rejects.toThrow(
      "snapshot storage offline",
    );

    snapshotUnavailable = false;
    manager.queuePersistSessionSnapshot("session.workflow_completed");
    await manager.waitForIdle({ throwOnError: true });

    expect(persistSessionMutation).toHaveBeenCalledTimes(1);
    expect(persistSessionSnapshot).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({ lastEventSeq: 14 }),
    );
  });
});
