import { describe, expect, mock, test } from "bun:test";

import { PersistenceManager } from "../../src/server/session/PersistenceManager";
import type { PersistedSessionMutation, SessionDb } from "../../src/server/sessionDb";

function createPersistenceHarness(opts: {
  persistSessionMutation?: (mutation: PersistedSessionMutation) => Promise<number>;
  persistSessionSnapshot?: (sessionId: string, snapshot: unknown) => Promise<void>;
  buildCanonicalSnapshot?: (updatedAt: string) => PersistedSessionMutation["snapshot"];
  buildSessionSnapshotAt?: (updatedAt: string, lastEventSeq: number) => unknown;
  onPersistedLastEventSeq?: (lastEventSeq: number) => void;
  persistenceEnabled?: boolean;
}) {
  const errors: string[] = [];
  const telemetry: Array<{
    name: string;
    status: "ok" | "error";
    attributes?: Record<string, string | number | boolean>;
  }> = [];
  const persistSessionMutation = mock(opts.persistSessionMutation ?? (async () => 1));
  const persistSessionSnapshot = mock(opts.persistSessionSnapshot ?? (async () => {}));
  const manager = new PersistenceManager({
    sessionId: "session-1",
    persistenceEnabled: opts.persistenceEnabled,
    sessionDb: { persistSessionMutation, persistSessionSnapshot } as unknown as SessionDb,
    getCoworkPaths: () => ({ sessionsDir: "/tmp/session-persistence" }) as never,
    writePersistedSessionSnapshot: async () => undefined,
    buildCanonicalSnapshot:
      opts.buildCanonicalSnapshot ?? (() => ({}) as PersistedSessionMutation["snapshot"]),
    buildPersistedSnapshotAt: () => ({}) as never,
    buildSessionSnapshotAt: (updatedAt, lastEventSeq) =>
      (opts.buildSessionSnapshotAt?.(updatedAt, lastEventSeq) ?? { lastEventSeq }) as never,
    onPersistedLastEventSeq: opts.onPersistedLastEventSeq,
    emitTelemetry: (name, status, attributes) => telemetry.push({ name, status, attributes }),
    emitError: (message) => errors.push(message),
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return { manager, errors, telemetry, persistSessionMutation, persistSessionSnapshot };
}

describe("session snapshot persistence reliability", () => {
  test("retries transient canonical-session and rich-snapshot writes independently", async () => {
    let canonicalAttempts = 0;
    const canonical = createPersistenceHarness({
      persistSessionMutation: async () => {
        if (++canonicalAttempts === 1) throw new Error("database is locked");
        return 7;
      },
    });
    canonical.manager.queuePersistSessionSnapshot("session.user_message");
    await canonical.manager.waitForIdle({ throwOnError: true });
    expect(canonical.persistSessionMutation).toHaveBeenCalledTimes(2);
    expect(canonical.persistSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(canonical.errors).toEqual([]);

    let snapshotAttempts = 0;
    const rich = createPersistenceHarness({
      persistSessionMutation: async () => 9,
      persistSessionSnapshot: async () => {
        if (++snapshotAttempts === 1) throw new Error("snapshot writer temporarily unavailable");
      },
    });
    rich.manager.queuePersistSessionSnapshot("session.workflow_completed");
    await rich.manager.waitForIdle({ throwOnError: true });
    expect(rich.persistSessionMutation).toHaveBeenCalledTimes(1);
    expect(rich.persistSessionSnapshot).toHaveBeenCalledTimes(2);
    expect(rich.persistSessionSnapshot).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({ lastEventSeq: 9 }),
    );
  });

  test("captures canonical and rich snapshots before asynchronous writes can advance state", async () => {
    let state = "first message";
    let lastSeq = 0;
    const persistedSnapshots: Array<{ lastEventSeq: number; state: string }> = [];
    const { manager, persistSessionMutation } = createPersistenceHarness({
      persistSessionMutation: async () => {
        if (++lastSeq === 1) {
          state = "second message";
          manager.queuePersistSessionSnapshot("session.user_message");
        }
        return lastSeq;
      },
      persistSessionSnapshot: async (_sessionId, snapshot) => {
        persistedSnapshots.push(snapshot as { lastEventSeq: number; state: string });
      },
      buildCanonicalSnapshot: () => ({ state }) as never,
      buildSessionSnapshotAt: (_updatedAt, lastEventSeq) => ({ lastEventSeq, state }),
    });

    manager.queuePersistSessionSnapshot("session.user_message");
    await manager.waitForIdle({ throwOnError: true });

    expect(persistSessionMutation.mock.calls.map(([mutation]) => mutation.snapshot)).toEqual([
      { state: "first message" },
      { state: "second message" },
    ]);
    expect(persistedSnapshots).toEqual([
      { lastEventSeq: 1, state: "first message" },
      { lastEventSeq: 2, state: "second message" },
    ]);
  });

  test("keeps exhausted mutation reasons pending until a later recovery succeeds", async () => {
    let failing = true;
    const { manager, errors, persistSessionMutation, persistSessionSnapshot } =
      createPersistenceHarness({
        persistSessionMutation: async () => {
          if (failing) throw new Error("persistent database outage");
          return 11;
        },
      });

    manager.queuePersistSessionSnapshot("session.user_message");
    await expect(manager.waitForIdle({ throwOnError: true })).rejects.toThrow(
      "persistent database outage",
    );
    expect(errors).toHaveLength(1);

    failing = false;
    manager.queuePersistSessionSnapshot("session.provider_recovered");
    await manager.waitForIdle({ throwOnError: true });

    expect(persistSessionMutation.mock.calls.at(-1)?.[0]?.payload).toMatchObject({
      reasons: ["session.user_message", "session.provider_recovered"],
    });
    expect(persistSessionSnapshot).toHaveBeenCalledTimes(1);
  });

  test("resumes exhausted rich snapshots before persisting newer canonical state (different or same reason)", async () => {
    let state = "accepted";
    let snapshotUnavailable = true;
    let lastSeq = 20;
    const persistedSnapshots: Array<{ lastEventSeq: number; state: string }> = [];
    const observedSeqs: number[] = [];
    const { manager, persistSessionMutation, persistSessionSnapshot } = createPersistenceHarness({
      persistSessionMutation: async () => ++lastSeq,
      persistSessionSnapshot: async (_sessionId, snapshot) => {
        if (snapshotUnavailable) throw new Error("rich snapshot unavailable");
        persistedSnapshots.push(snapshot as { lastEventSeq: number; state: string });
      },
      buildCanonicalSnapshot: () => ({ state }) as never,
      buildSessionSnapshotAt: (_updatedAt, lastEventSeq) => ({ lastEventSeq, state }),
      onPersistedLastEventSeq: (seq) => observedSeqs.push(seq),
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

    snapshotUnavailable = true;
    manager.queuePersistSessionSnapshot("session.workflow_completed");
    await expect(manager.waitForIdle({ throwOnError: true })).rejects.toThrow(
      "rich snapshot unavailable",
    );

    state = "second message";
    snapshotUnavailable = false;
    manager.queuePersistSessionSnapshot("session.workflow_completed");
    await manager.waitForIdle({ throwOnError: true });

    expect(persistedSnapshots.slice(-2)).toEqual([
      { lastEventSeq: 23, state: "resolved" },
      { lastEventSeq: 24, state: "second message" },
    ]);
  });

  test("handles disabled persistence, pending seq projection, and exhausted sqlite lock telemetry", async () => {
    const disabled = createPersistenceHarness({ persistenceEnabled: false });
    disabled.manager.queuePersistSessionSnapshot("session.user_message");
    await disabled.manager.waitForIdle({ throwOnError: true });
    expect(disabled.persistSessionMutation).not.toHaveBeenCalled();
    expect(disabled.persistSessionSnapshot).not.toHaveBeenCalled();
    expect(disabled.errors).toEqual([]);
    expect(disabled.telemetry).toEqual([]);
    expect(disabled.manager.getProjectedLastEventSeq(4)).toBe(4);

    const gate = Promise.withResolvers<void>();
    const projected = createPersistenceHarness({
      persistSessionMutation: async () => {
        await gate.promise;
        return 5;
      },
    });
    projected.manager.queuePersistSessionSnapshot("session.user_message");
    expect(projected.manager.getProjectedLastEventSeq(4)).toBe(5);
    gate.resolve();
    await projected.manager.waitForIdle({ throwOnError: true });
    expect(projected.manager.getProjectedLastEventSeq(5)).toBe(5);

    const locked = createPersistenceHarness({
      persistSessionMutation: async () => {
        throw new Error("database is locked");
      },
    });
    locked.manager.queuePersistSessionSnapshot("session.user_message");
    await expect(locked.manager.waitForIdle({ throwOnError: true })).rejects.toThrow(
      "database is locked",
    );
    expect(locked.persistSessionMutation).toHaveBeenCalledTimes(3);
    expect(locked.persistSessionSnapshot).not.toHaveBeenCalled();
    expect(locked.errors).toEqual(["Failed to persist session state: database is locked"]);
    const expectedAttrs = {
      sessionId: "session-1",
      reason: "session.user_message",
      error: "database is locked",
    };
    expect(locked.telemetry).toContainEqual({
      name: "session.snapshot.persist",
      status: "error",
      attributes: expectedAttrs,
    });
    expect(locked.telemetry).toContainEqual({
      name: "session.db.sqlite_lock",
      status: "error",
      attributes: expectedAttrs,
    });
  });
});
