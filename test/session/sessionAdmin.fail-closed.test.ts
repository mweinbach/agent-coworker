import { describe, expect, test } from "bun:test";
import { SessionAdminManager } from "../../src/server/session/SessionAdminManager";
import type { SessionContext } from "../../src/server/session/SessionContext";

type EmittedError = { code: string; source: string; message: string };

function makeContext(overrides: Partial<SessionContext> = {}): {
  context: SessionContext;
  errors: EmittedError[];
  events: unknown[];
} {
  const errors: EmittedError[] = [];
  const events: unknown[] = [];
  const context = {
    id: "session-1",
    state: {
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
        workingDirectory: "/tmp/project",
        userName: "",
        knowledgeCutoff: "unknown",
        projectCoworkDir: "/tmp/project/.cowork",
        userCoworkDir: "/tmp/.cowork",
        builtInDir: "/tmp/project",
        builtInConfigDir: "/tmp/project/config",
        skillsDirs: [],
        memoryDirs: [],
        configDirs: [],
        enableMcp: true,
        backupsEnabled: false,
      },
      system: "system",
      discoveredSkills: [],
      yolo: false,
      messages: [],
      allMessages: [],
      historyRevision: 0,
      running: false,
      connecting: false,
      abortController: null,
      currentTurnId: null,
      currentTurnOutcome: "completed",
      maxSteps: 100,
      todos: [{ id: "todo-1", content: "keep" }],
      sessionInfo: {
        title: "New Session",
        titleSource: "default",
        titleModel: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        provider: "google",
        model: "gemini-3-flash-preview",
        sessionKind: "root",
      },
      persistenceStatus: "active",
      hasGeneratedTitle: false,
      lastMemoryGeneratedIndex: 4,
      providerState: { kind: "keep" },
      sessionBackup: null,
      backupsEnabledOverride: null,
    },
    deps: {},
    emit: (evt: unknown) => {
      events.push(evt);
    },
    emitError: (code: string, source: string, message: string) => {
      errors.push({ code, source, message });
    },
    queuePersistSessionSnapshot: () => {},
    ...overrides,
  } as SessionContext;
  return { context, errors, events };
}

describe("SessionAdminManager fail-closed gates", () => {
  test("reset while running emits busy and leaves conversation state intact", () => {
    const { context, errors, events } = makeContext();
    context.state.running = true;
    context.state.messages = [{ role: "user", content: "keep" }] as never;
    context.state.allMessages = [{ role: "user", content: "keep" }] as never;
    const persisted: string[] = [];
    context.queuePersistSessionSnapshot = (reason) => persisted.push(reason);

    new SessionAdminManager(context).reset();

    expect(errors).toEqual([{ code: "busy", source: "session", message: "Agent is busy" }]);
    expect(events).toEqual([]);
    expect(persisted).toEqual([]);
    expect(context.state.messages).toEqual([{ role: "user", content: "keep" }]);
    expect(context.state.todos).toEqual([{ id: "todo-1", content: "keep" }]);
    expect(context.state.historyRevision).toBe(0);
    expect(context.state.lastMemoryGeneratedIndex).toBe(4);
    expect(context.state.providerState).toEqual({ kind: "keep" });
  });

  test("child sessions cannot list, snapshot, or spawn agents", async () => {
    const { context, errors, events } = makeContext();
    context.state.sessionInfo.sessionKind = "agent";
    context.deps.listAgentSessionsImpl = async () => [];
    context.deps.createAgentSessionImpl = async () => {
      throw new Error("should not spawn");
    };
    const manager = new SessionAdminManager(context);

    await manager.listSessions();
    await manager.getSessionSnapshot("other");
    await manager.listAgentSessions();
    await manager.createAgentSession({ message: "go" });
    await manager.listWorkspaceBackups();

    expect(events).toEqual([]);
    expect(errors).toEqual([
      {
        code: "validation_failed",
        source: "session",
        message: "Only root sessions can list sessions",
      },
      {
        code: "validation_failed",
        source: "session",
        message: "Only root sessions can fetch session snapshots",
      },
      {
        code: "validation_failed",
        source: "session",
        message: "Only root sessions can list child agents",
      },
      {
        code: "validation_failed",
        source: "session",
        message: "Only root sessions can create child agents",
      },
      {
        code: "validation_failed",
        source: "backup",
        message: "Only root sessions can list workspace backups",
      },
    ]);
  });

  test("getSessionSnapshot refuses live children, foreign workspaces, and missing snapshots", async () => {
    const { context, errors, events } = makeContext();
    const manager = new SessionAdminManager(context);

    context.deps.getLiveSessionSnapshotImpl = () => ({ sessionKind: "agent" }) as never;
    context.deps.getLiveSessionWorkingDirectoryImpl = () => "/tmp/project";
    await manager.getSessionSnapshot("child-session");

    context.deps.getLiveSessionSnapshotImpl = () => ({ sessionKind: "root" }) as never;
    context.deps.getLiveSessionWorkingDirectoryImpl = () => "/tmp/other-project";
    await manager.getSessionSnapshot("foreign-live");

    context.deps.getLiveSessionSnapshotImpl = () => null;
    context.deps.getLiveSessionWorkingDirectoryImpl = () => null;
    context.deps.sessionDb = {
      getSessionRecord: () => null,
    } as never;
    await manager.getSessionSnapshot("missing");

    context.deps.sessionDb = {
      getSessionRecord: () => ({
        sessionKind: "root",
        workingDirectory: "/tmp/other-project",
      }),
    } as never;
    await manager.getSessionSnapshot("foreign-persisted");

    context.deps.sessionDb = {
      getSessionRecord: () => ({
        sessionKind: "root",
        workingDirectory: "/tmp/project",
      }),
      getSessionSnapshot: () => null,
    } as never;
    await manager.getSessionSnapshot("empty-record");

    expect(events).toEqual([]);
    expect(errors).toEqual([
      {
        code: "validation_failed",
        source: "session",
        message: "Only root sessions can be hydrated via session snapshots",
      },
      {
        code: "permission_denied",
        source: "session",
        message: "Target session is outside the active workspace",
      },
      { code: "validation_failed", source: "session", message: "Unknown target session: missing" },
      {
        code: "permission_denied",
        source: "session",
        message: "Target session is outside the active workspace",
      },
      {
        code: "internal_error",
        source: "session",
        message: "No snapshot available for session: empty-record",
      },
    ]);
  });

  test("deleteSession cannot target the active session", async () => {
    const { context, errors } = makeContext();
    let deleted = false;
    context.deps.deleteSessionImpl = async () => {
      deleted = true;
    };

    await new SessionAdminManager(context).deleteSession("session-1");

    expect(deleted).toBe(false);
    expect(errors).toEqual([
      { code: "validation_failed", source: "session", message: "Cannot delete the active session" },
    ]);
  });

  test("child-agent and backup operations fail closed when the impl or feature is missing", async () => {
    const { context, errors, events } = makeContext();
    const manager = new SessionAdminManager(context);

    await manager.listAgentSessions();
    await manager.createAgentSession({ message: "go" });
    await manager.listWorkspaceBackups();
    context.state.config.backupsEnabled = true;
    await manager.listWorkspaceBackups();

    expect(events).toEqual([]);
    expect(errors).toEqual([
      { code: "internal_error", source: "session", message: "Child-agent listing is unavailable" },
      { code: "internal_error", source: "session", message: "Child-agent creation is unavailable" },
      {
        code: "backup_error",
        source: "backup",
        message:
          "Workspace backup APIs are disabled. Enable backups for this workspace or session to use advanced backup snapshots.",
      },
      {
        code: "internal_error",
        source: "backup",
        message: "Workspace backup operation is unavailable: list workspace backups",
      },
    ]);
  });

  test("uploadFile rejects invalid names and malformed payloads before writing", async () => {
    const { context, errors, events } = makeContext();
    const manager = new SessionAdminManager(context);

    await manager.uploadFile("", "YQ==");
    await manager.uploadFile(".", "YQ==");
    await manager.uploadFile("..", "YQ==");
    await manager.uploadFile("ok.txt", "!not-base64!");

    expect(events).toEqual([]);
    expect(errors).toEqual([
      { code: "validation_failed", source: "session", message: "Invalid filename" },
      { code: "validation_failed", source: "session", message: "Invalid filename" },
      { code: "validation_failed", source: "session", message: "Invalid filename" },
      { code: "validation_failed", source: "session", message: "Invalid base64 file contents" },
    ]);
  });

  test("getMessages floors negative offsets and zero limits", () => {
    const { context, events } = makeContext();
    context.state.allMessages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ] as never;

    new SessionAdminManager(context).getMessages(-3.7, 0);

    expect(events).toEqual([
      {
        type: "messages",
        sessionId: "session-1",
        messages: [{ role: "user", content: "a" }],
        total: 3,
        offset: 0,
        limit: 1,
      },
    ]);
  });
});
