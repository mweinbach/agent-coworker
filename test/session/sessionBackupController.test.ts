import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "../../src/server/protocol";
import { SessionBackupController } from "../../src/server/session/SessionBackupController";
import type { SessionContext, SessionRuntimeState } from "../../src/server/session/SessionContext";
import type {
  SessionBackupHandle,
  SessionBackupPublicCheckpoint,
  SessionBackupPublicState,
} from "../../src/server/sessionBackup";

const SESSION_ID = "session-backup-controller";

function placeholderState(
  status: SessionBackupPublicState["status"] = "initializing",
): SessionBackupPublicState {
  return {
    status,
    sessionId: SESSION_ID,
    workingDirectory: "/workspace",
    backupDirectory: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    originalSnapshot: { kind: "pending" },
    checkpoints: [],
  };
}

function createBackupHandle(): SessionBackupHandle & {
  createCheckpoint: ReturnType<typeof mock>;
} {
  const checkpoints: SessionBackupPublicCheckpoint[] = [];
  const publicState = (): SessionBackupPublicState => ({
    ...placeholderState("ready"),
    backupDirectory: "/backups/session-backup-controller",
    originalSnapshot: { kind: "directory" },
    checkpoints: [...checkpoints],
  });
  return {
    getPublicState: () => publicState(),
    createCheckpoint: mock(async (trigger: SessionBackupPublicCheckpoint["trigger"]) => {
      const checkpoint: SessionBackupPublicCheckpoint = {
        id: `cp-${checkpoints.length + 1}`,
        index: checkpoints.length + 1,
        createdAt: "2026-09-23T00:00:00.000Z",
        trigger,
        changed: true,
        patchBytes: 8,
      };
      checkpoints.push(checkpoint);
      return checkpoint;
    }),
    restoreOriginal: async () => {},
    restoreCheckpoint: async () => {},
    deleteCheckpoint: async () => true,
    reloadFromDisk: async () => publicState(),
    close: async () => {},
  };
}

function createHarness(opts?: { backupsEnabled?: boolean }) {
  const events: SessionEvent[] = [];
  const telemetry: Array<{ name: string; status: "ok" | "error" }> = [];
  const backup = createBackupHandle();
  const sessionBackupFactory = mock(async () => backup);
  const state = {
    running: false,
    backupsEnabledOverride: opts?.backupsEnabled ?? false,
    config: {
      backupsEnabled: opts?.backupsEnabled ?? false,
      workingDirectory: "/workspace",
      userCoworkDir: "/home/tester/.cowork",
    },
    sessionInfo: { createdAt: "2026-09-01T00:00:00.000Z" },
    sessionBackup: null,
    sessionBackupState: placeholderState(),
    sessionBackupInit: null,
    backupOperationQueue: Promise.resolve(),
    lastAutoCheckpointAt: 0,
  } as SessionRuntimeState;
  const context = {
    id: SESSION_ID,
    state,
    deps: { sessionBackupFactory },
    emit: (event: SessionEvent) => {
      events.push(event);
    },
    emitError: (code: string, source: string, message: string) => {
      events.push({
        type: "error",
        sessionId: SESSION_ID,
        code,
        source,
        message,
      } as SessionEvent);
    },
    emitTelemetry: (name: string, status: "ok" | "error") => {
      telemetry.push({ name, status });
    },
    formatError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  } as SessionContext;
  return {
    controller: new SessionBackupController(context),
    events,
    telemetry,
    state,
    backup,
    sessionBackupFactory,
  };
}

describe("SessionBackupController", () => {
  test("rejects manual backup mutations immediately while a turn is running", async () => {
    const { controller, events, state, sessionBackupFactory } = createHarness({
      backupsEnabled: true,
    });
    state.running = true;

    const manual = controller.createManualSessionCheckpoint();
    state.running = false;
    await manual;

    state.running = true;
    await controller.restoreSessionBackup("cp-1");
    await controller.deleteSessionCheckpoint("cp-1");

    expect(sessionBackupFactory).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "busy",
        source: "session",
        message: "Agent is busy",
      },
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "busy",
        source: "session",
        message: "Agent is busy",
      },
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "busy",
        source: "session",
        message: "Agent is busy",
      },
    ]);
  });

  test("throttles automatic checkpoints to one per interval, including overlapping calls", async () => {
    const { controller, state, backup, telemetry, sessionBackupFactory } = createHarness({
      backupsEnabled: true,
    });
    state.sessionBackup = backup;
    state.sessionBackupInit = Promise.resolve();
    state.sessionBackupState = backup.getPublicState();

    await Promise.all([
      controller.takeAutomaticSessionCheckpoint(),
      controller.takeAutomaticSessionCheckpoint(),
    ]);
    await controller.takeAutomaticSessionCheckpoint();

    expect(sessionBackupFactory).not.toHaveBeenCalled();
    expect(backup.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(backup.createCheckpoint).toHaveBeenCalledWith("auto");
    expect(state.lastAutoCheckpointAt).toBeGreaterThan(0);
    expect(telemetry).toEqual([{ name: "session.backup.checkpoint.auto", status: "ok" }]);
  });

  test("reports disabled backups without creating a checkpoint and clears the throttle", async () => {
    const { controller, events, state, sessionBackupFactory } = createHarness();
    state.lastAutoCheckpointAt = 50_000;

    await controller.createManualSessionCheckpoint();

    expect(sessionBackupFactory).not.toHaveBeenCalled();
    expect(state.sessionBackup).toBeNull();
    expect(state.sessionBackupState.status).toBe("disabled");
    expect(state.lastAutoCheckpointAt).toBe(0);
    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "backup_error",
        source: "backup",
        message: "Session backups are disabled",
      },
    ]);
    expect(events.some((event) => event.type === "session_backup_state")).toBe(false);
  });

  test("keeps a failed initialization until availability sync retries it", async () => {
    const backup = createBackupHandle();
    let attempts = 0;
    const { controller, events, state, sessionBackupFactory } = createHarness({
      backupsEnabled: true,
    });
    sessionBackupFactory.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
      return backup;
    });

    await controller.getSessionBackupState();
    expect(state.sessionBackup).toBeNull();
    expect(state.sessionBackupState).toMatchObject({
      status: "failed",
      failureReason: "session backup initialization failed: Error: disk full",
    });

    await controller.createManualSessionCheckpoint();
    expect(backup.createCheckpoint).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "backup_error",
        source: "backup",
        message: "session backup initialization failed: Error: disk full",
      },
    ]);

    await controller.syncSessionBackupAvailability();
    expect(sessionBackupFactory).toHaveBeenCalledTimes(2);
    expect(sessionBackupFactory).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      workingDirectory: "/workspace",
      homedir: "/home/tester",
    });
    expect(state.sessionBackupState.status).toBe("ready");
    expect(
      events.flatMap((event) =>
        event.type === "session_backup_state" ? [event.backup.status] : [],
      ),
    ).toEqual(["failed", "ready"]);
  });
});
