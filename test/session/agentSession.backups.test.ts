import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  flushAsyncWork,
  fs,
  getSupportedModel,
  isRecord,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  makeConfig,
  makeEmit,
  makeSession,
  makeSessionBackupFactory,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  REAL_AGENT,
  resetAgentSessionMocks,
  SessionCostTracker,
  waitForCondition,
  withEnv,
} from "./agentSession.harness";

describe("AgentSession", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  describe("session backups", () => {
    test("getSessionBackupState reports disabled by default", async () => {
      const { session, events } = makeSession();
      await session.getSessionBackupState();

      const evt = events.find((e) => e.type === "session_backup_state");
      expect(evt).toBeDefined();
      if (evt && evt.type === "session_backup_state") {
        expect(evt.reason).toBe("requested");
        expect(evt.backup.status).toBe("disabled");
        expect(evt.backup.backupDirectory).toBeNull();
        expect(evt.backup.checkpoints).toEqual([]);
      }
    });

    test("enabled sessions emit a ready session_backup_state event", async () => {
      const dir = path.join(os.tmpdir(), `session-backups-enabled-${Date.now()}`);
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          backupsEnabled: true,
        },
      });
      await session.getSessionBackupState();

      const evt = events.find((e) => e.type === "session_backup_state");
      expect(evt).toBeDefined();
      if (evt && evt.type === "session_backup_state") {
        expect(evt.reason).toBe("requested");
        expect(evt.backup.status).toBe("ready");
        expect(evt.backup.checkpoints).toHaveLength(1);
        expect(evt.backup.checkpoints[0]?.trigger).toBe("initial");
      }
    });

    test("disabled sessions emit a disabled backup state with no checkpoints", async () => {
      const dir = path.join(os.tmpdir(), `session-backups-disabled-${Date.now()}`);
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          backupsEnabled: false,
        },
      });

      await session.getSessionBackupState();

      const evt = events.find((event) => event.type === "session_backup_state");
      expect(evt).toBeDefined();
      if (evt && evt.type === "session_backup_state") {
        expect(evt.backup.status).toBe("disabled");
        expect(evt.backup.backupDirectory).toBeNull();
        expect(evt.backup.checkpoints).toEqual([]);
      }
    });

    test("sendUserMessage does not emit auto checkpoint state when backups are disabled", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("do not checkpoint me");

      expect(
        events.some((e) => e.type === "session_backup_state" && e.reason === "auto_checkpoint"),
      ).toBe(false);
    });

    test("sendUserMessage emits auto checkpoint state after completion when backups are enabled", async () => {
      const dir = path.join(os.tmpdir(), `session-backups-auto-${Date.now()}`);
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          backupsEnabled: true,
        },
      });
      await session.sendUserMessage("checkpoint me");
      for (let i = 0; i < 40; i += 1) {
        if (events.some((e) => e.type === "session_backup_state" && e.reason === "auto_checkpoint"))
          break;
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      const backupEvents = events.filter((e) => e.type === "session_backup_state") as Array<
        Extract<SessionEvent, { type: "session_backup_state" }>
      >;
      const auto = backupEvents.find((e) => e.reason === "auto_checkpoint");
      expect(auto).toBeDefined();
      if (auto) {
        expect(auto.backup.checkpoints).toHaveLength(2);
        expect(auto.backup.checkpoints[0]?.trigger).toBe("initial");
        expect(auto.backup.checkpoints[1]?.trigger).toBe("auto");
      }
    });

    test("createManualSessionCheckpoint emits manual checkpoint state", async () => {
      const dir = path.join(os.tmpdir(), `session-backups-manual-${Date.now()}`);
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          backupsEnabled: true,
        },
      });
      await session.createManualSessionCheckpoint();

      const manual = events.find(
        (e) => e.type === "session_backup_state" && e.reason === "manual_checkpoint",
      ) as Extract<SessionEvent, { type: "session_backup_state" }> | undefined;
      expect(manual).toBeDefined();
      if (manual) {
        expect(manual.backup.checkpoints).toHaveLength(2);
        expect(manual.backup.checkpoints[0]?.trigger).toBe("initial");
        expect(manual.backup.checkpoints[1]?.trigger).toBe("manual");
      }
    });

    test("restoreSessionBackup routes original and checkpoint restores to the backup handle", async () => {
      let restoreOriginalCalls = 0;
      const restoreCheckpointCalls: string[] = [];
      const backupFactory = mock(
        async (opts: SessionBackupInitOptions): Promise<SessionBackupHandle> => {
          const createdAt = new Date().toISOString();
          const checkpoints: SessionBackupPublicCheckpoint[] = [
            {
              id: "cp-0001",
              index: 1,
              createdAt,
              trigger: "initial",
              changed: false,
              patchBytes: 0,
            },
          ];

          const getState = (): SessionBackupPublicState => ({
            status: "ready",
            sessionId: opts.sessionId,
            workingDirectory: opts.workingDirectory,
            backupDirectory: `/tmp/mock-backups/${opts.sessionId}`,
            createdAt,
            originalSnapshot: { kind: "directory" },
            checkpoints: [...checkpoints],
          });

          return {
            getPublicState: () => getState(),
            createCheckpoint: async (trigger) => {
              const checkpoint: SessionBackupPublicCheckpoint = {
                id: `cp-${String(checkpoints.length + 1).padStart(4, "0")}`,
                index: checkpoints.length + 1,
                createdAt: new Date().toISOString(),
                trigger,
                changed: true,
                patchBytes: 42,
              };
              checkpoints.push(checkpoint);
              return checkpoint;
            },
            restoreOriginal: async () => {
              restoreOriginalCalls += 1;
            },
            restoreCheckpoint: async (checkpointId) => {
              restoreCheckpointCalls.push(checkpointId);
              if (!checkpoints.some((cp) => cp.id === checkpointId)) {
                throw new Error(`Unknown checkpoint: ${checkpointId}`);
              }
            },
            deleteCheckpoint: async () => false,
            reloadFromDisk: async () => getState(),
            close: async () => {},
          };
        },
      );

      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          backupsEnabled: true,
        },
        sessionBackupFactory: backupFactory,
      });
      await session.createManualSessionCheckpoint();
      await session.restoreSessionBackup();
      await session.restoreSessionBackup("cp-0001");

      expect(restoreOriginalCalls).toBe(1);
      expect(restoreCheckpointCalls).toEqual(["cp-0001"]);
      const restoreEvents = events.filter(
        (e) => e.type === "session_backup_state" && e.reason === "restore",
      ) as Array<Extract<SessionEvent, { type: "session_backup_state" }>>;
      expect(restoreEvents).toHaveLength(2);
      expect(restoreEvents.every((evt) => evt.backup.status === "ready")).toBe(true);
    });

    test("deleteSessionCheckpoint emits error when checkpoint does not exist", async () => {
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          backupsEnabled: true,
        },
      });
      await session.deleteSessionCheckpoint("does-not-exist");

      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      if (err && err.type === "error") {
        expect(err.message).toContain("Unknown checkpoint id");
      }
    });

    test("manual checkpoint requests are serialized", async () => {
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          backupsEnabled: true,
        },
      });

      await Promise.all([
        session.createManualSessionCheckpoint(),
        session.createManualSessionCheckpoint(),
      ]);

      const manualEvents = events.filter(
        (e) => e.type === "session_backup_state" && e.reason === "manual_checkpoint",
      ) as Array<Extract<SessionEvent, { type: "session_backup_state" }>>;
      expect(manualEvents.length).toBe(2);
      expect(manualEvents[1]?.backup.checkpoints.length).toBe(3);
    });
  });

  // =========================================================================
  // Edge cases / Integration
  // =========================================================================
});
