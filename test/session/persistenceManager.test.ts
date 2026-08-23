import { describe, expect, mock, test } from "bun:test";

import type { AiCoworkerPaths } from "../../src/connect";
import { PersistenceManager } from "../../src/server/session/PersistenceManager";
import type { PersistedSessionMutation, SessionDb } from "../../src/server/sessionDb";
import type { PersistedSessionSnapshot } from "../../src/server/sessionStore";
import type { SessionSnapshot } from "../../src/shared/sessionSnapshot";

type TelemetryEvent = {
  name: string;
  status: "ok" | "error";
  attributes?: Record<string, string | number | boolean>;
};

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHarness(
  overrides: {
    persistenceEnabled?: boolean;
    sessionDb?: SessionDb | null;
    persistSessionMutation?: (input: PersistedSessionMutation) => Promise<number>;
    persistSessionSnapshot?: (sessionId: string, snapshot: SessionSnapshot) => Promise<void>;
    writePersistedSessionSnapshot?: () => Promise<string | undefined>;
    onPersistedLastEventSeq?: (lastEventSeq: number) => void;
  } = {},
) {
  const telemetry: TelemetryEvent[] = [];
  const errors: string[] = [];
  let seq = 0;
  const persistSessionMutation =
    overrides.persistSessionMutation ??
    mock(async () => {
      seq += 1;
      return seq;
    });
  const persistSessionSnapshot = overrides.persistSessionSnapshot ?? mock(async () => undefined);
  const writePersistedSessionSnapshot =
    overrides.writePersistedSessionSnapshot ?? mock(async () => undefined);
  const sessionDb =
    overrides.sessionDb === null
      ? null
      : (overrides.sessionDb ??
        ({
          persistSessionMutation,
          persistSessionSnapshot,
        } as unknown as SessionDb));

  const manager = new PersistenceManager({
    sessionId: "session-test",
    persistenceEnabled: overrides.persistenceEnabled,
    sessionDb,
    getCoworkPaths: () => ({ sessionsDir: "/workspace/.cowork-sessions" }) as AiCoworkerPaths,
    writePersistedSessionSnapshot,
    buildCanonicalSnapshot: () => ({}) as PersistedSessionMutation["snapshot"],
    buildPersistedSnapshotAt: () => ({ sessionId: "session-test" }) as PersistedSessionSnapshot,
    buildSessionSnapshotAt: (_updatedAt, lastEventSeq) =>
      ({ sessionId: "session-test", lastEventSeq }) as SessionSnapshot,
    onPersistedLastEventSeq: overrides.onPersistedLastEventSeq,
    emitTelemetry: (name, status, attributes) => {
      telemetry.push({ name, status, attributes });
    },
    emitError: (message) => {
      errors.push(message);
    },
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return {
    manager,
    persistSessionMutation,
    persistSessionSnapshot,
    writePersistedSessionSnapshot,
    telemetry,
    errors,
  };
}

describe("PersistenceManager", () => {
  test("coalesces concurrent reasons into one persist and uses the last reason", async () => {
    const { manager, persistSessionMutation, persistSessionSnapshot, telemetry } = createHarness();

    manager.queuePersistSessionSnapshot("session.user_message");
    manager.queuePersistSessionSnapshot("session.todos_updated");
    manager.queuePersistSessionSnapshot("session.config_updated");
    await manager.waitForIdle();

    expect(persistSessionMutation).toHaveBeenCalledTimes(1);
    expect(persistSessionSnapshot).toHaveBeenCalledTimes(1);
    const mutation = persistSessionMutation.mock.calls[0]?.[0];
    expect(mutation?.eventType).toBe("session.config_updated");
    expect(mutation?.payload).toEqual({
      reason: "session.config_updated",
      reasons: ["session.user_message", "session.todos_updated", "session.config_updated"],
    });
    expect(telemetry).toContainEqual({
      name: "session.snapshot.persist",
      status: "ok",
      attributes: {
        sessionId: "session-test",
        reason: "session.config_updated",
        coalescedReasonCount: 3,
      },
    });
  });

  test("collapses duplicate reasons before the first flush", async () => {
    const { manager, persistSessionMutation, telemetry } = createHarness();

    manager.queuePersistSessionSnapshot("session.agent_status");
    manager.queuePersistSessionSnapshot("session.agent_status");
    manager.queuePersistSessionSnapshot("session.agent_status");
    await manager.waitForIdle();

    expect(persistSessionMutation).toHaveBeenCalledTimes(1);
    expect(telemetry[0]?.attributes?.coalescedReasonCount).toBe(1);
  });

  test("persists a second batch when reasons arrive during an in-flight flush", async () => {
    const started = createDeferred();
    const gate = createDeferred();
    const persistSessionMutation = mock(async (input: PersistedSessionMutation) => {
      if (input.eventType === "reason-a") {
        started.resolve();
        await gate.promise;
      }
      return input.eventType === "reason-a" ? 1 : 2;
    });
    const { manager } = createHarness({ persistSessionMutation });

    manager.queuePersistSessionSnapshot("reason-a");
    await started.promise;
    manager.queuePersistSessionSnapshot("reason-b");
    gate.resolve();
    await manager.waitForIdle();

    expect(persistSessionMutation).toHaveBeenCalledTimes(2);
    expect(persistSessionMutation.mock.calls[0]?.[0]?.eventType).toBe("reason-a");
    expect(persistSessionMutation.mock.calls[1]?.[0]?.eventType).toBe("reason-b");
  });

  test("projects lastEventSeq +1 while a persist is queued or in flight", async () => {
    const gate = createDeferred();
    const persistedSeqs: number[] = [];
    const persistSessionMutation = mock(async () => {
      await gate.promise;
      return 5;
    });
    const { manager } = createHarness({
      persistSessionMutation,
      onPersistedLastEventSeq: (seq) => {
        persistedSeqs.push(seq);
      },
    });

    expect(manager.getProjectedLastEventSeq(4)).toBe(4);
    manager.queuePersistSessionSnapshot("session.user_message");
    expect(manager.getProjectedLastEventSeq(4)).toBe(5);

    gate.resolve();
    await manager.waitForIdle();
    expect(persistedSeqs).toEqual([5]);
    expect(manager.getProjectedLastEventSeq(5)).toBe(5);
  });

  test("requeues later reasons after a sqlite lock and emits lock telemetry", async () => {
    const started = createDeferred();
    const gate = createDeferred();
    let calls = 0;
    const persistSessionMutation = mock(async () => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await gate.promise;
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return 2;
    });
    const { manager, telemetry, errors } = createHarness({ persistSessionMutation });

    manager.queuePersistSessionSnapshot("session.user_message");
    await started.promise;
    manager.queuePersistSessionSnapshot("session.turn_response");
    gate.resolve();
    await manager.waitForIdle();

    expect(persistSessionMutation).toHaveBeenCalledTimes(2);
    expect(persistSessionMutation.mock.calls[1]?.[0]?.eventType).toBe("session.turn_response");
    expect(telemetry).toContainEqual({
      name: "session.snapshot.persist",
      status: "error",
      attributes: {
        sessionId: "session-test",
        reason: "session.user_message",
        error: "SQLITE_BUSY: database is locked",
      },
    });
    expect(telemetry).toContainEqual({
      name: "session.db.sqlite_lock",
      status: "error",
      attributes: {
        sessionId: "session-test",
        reason: "session.user_message",
        error: "SQLITE_BUSY: database is locked",
      },
    });
    expect(errors).toEqual(["Failed to persist session state: SQLITE_BUSY: database is locked"]);
  });

  test("does not retry a drained batch after a sqlite lock", async () => {
    const persistSessionMutation = mock(async () => {
      throw new Error("database is locked");
    });
    const { manager, telemetry } = createHarness({ persistSessionMutation });

    manager.queuePersistSessionSnapshot("session.user_message");
    await manager.waitForIdle();

    expect(persistSessionMutation).toHaveBeenCalledTimes(1);
    expect(telemetry.filter((event) => event.name === "session.db.sqlite_lock")).toHaveLength(1);
  });

  test("does not emit sqlite lock telemetry for unrelated persist errors", async () => {
    const persistSessionMutation = mock(async () => {
      throw new Error("disk full");
    });
    const { manager, telemetry } = createHarness({ persistSessionMutation });

    manager.queuePersistSessionSnapshot("session.user_message");
    await manager.waitForIdle();

    expect(persistSessionMutation).toHaveBeenCalledTimes(1);
    expect(telemetry.some((event) => event.name === "session.db.sqlite_lock")).toBe(false);
    expect(telemetry).toContainEqual({
      name: "session.snapshot.persist",
      status: "error",
      attributes: {
        sessionId: "session-test",
        reason: "session.user_message",
        error: "disk full",
      },
    });
  });

  test("skips persist work when persistence is disabled", async () => {
    const { manager, persistSessionMutation, writePersistedSessionSnapshot } = createHarness({
      persistenceEnabled: false,
    });

    manager.queuePersistSessionSnapshot("session.user_message");
    await manager.waitForIdle();

    expect(persistSessionMutation).toHaveBeenCalledTimes(0);
    expect(writePersistedSessionSnapshot).toHaveBeenCalledTimes(0);
    expect(manager.getProjectedLastEventSeq(3)).toBe(3);
  });

  test("writes the JSON snapshot path when sessionDb is absent", async () => {
    const { manager, persistSessionMutation, writePersistedSessionSnapshot } = createHarness({
      sessionDb: null,
    });

    manager.queuePersistSessionSnapshot("session.created");
    await manager.waitForIdle();

    expect(persistSessionMutation).toHaveBeenCalledTimes(0);
    expect(writePersistedSessionSnapshot).toHaveBeenCalledTimes(1);
  });
});
