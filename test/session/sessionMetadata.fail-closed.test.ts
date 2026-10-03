import { describe, expect, mock, test } from "bun:test";
import type { SessionContext } from "../../src/server/session/SessionContext";
import { SessionMetadataManager } from "../../src/server/session/SessionMetadataManager";

type EmittedError = { code: string; source: string; message: string };

function makeContext(): {
  context: SessionContext;
  errors: EmittedError[];
  persist: ReturnType<typeof mock>;
  persistedReasons: string[];
} {
  const errors: EmittedError[] = [];
  const persistedReasons: string[] = [];
  const persist = mock(async () => {});
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
        memoryGenerationModel: "gemini-old",
        skillImprovementModel: "openai:gpt-5.2",
        toolOutputOverflowChars: 12000,
      },
      system: "system",
      discoveredSkills: [],
      yolo: false,
      messages: [],
      allMessages: [],
      historyRevision: 0,
      running: false,
      maxSteps: 100,
      todos: [],
      sessionInfo: {
        title: "New Session",
        titleSource: "default",
        titleModel: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        provider: "google",
        model: "gemini-3-flash-preview",
      },
      persistenceStatus: "active",
      hasGeneratedTitle: false,
      backupsEnabledOverride: null,
    },
    deps: {
      persistProjectConfigPatchImpl: persist,
    },
    emit: () => {},
    emitError: (code: string, source: string, message: string) => {
      errors.push({ code, source, message });
    },
    emitTelemetry: () => {},
    queuePersistSessionSnapshot: (reason: string) => persistedReasons.push(reason),
    formatError: (err: unknown) => String(err),
  } as SessionContext;
  return { context, errors, persist, persistedReasons };
}

describe("SessionMetadataManager fail-closed gates", () => {
  test("rejects combining a value with its clear flag and does not persist", async () => {
    const { context, errors, persist } = makeContext();
    const before = { ...context.state.config };
    const manager = new SessionMetadataManager(context);

    await manager.setConfig({
      memoryGenerationModel: "gemini-new",
      clearMemoryGenerationModel: true,
    });
    await manager.setConfig({
      skillImprovementModel: "openai:gpt-5.4",
      clearSkillImprovementModel: true,
    });
    await manager.setConfig({
      toolOutputOverflowChars: 8000,
      clearToolOutputOverflowChars: true,
    });

    expect(persist).not.toHaveBeenCalled();
    expect(context.state.config).toEqual(before);
    expect(errors).toEqual([
      {
        code: "validation_failed",
        source: "session",
        message: "memoryGenerationModel cannot be combined with clearMemoryGenerationModel",
      },
      {
        code: "validation_failed",
        source: "session",
        message: "skillImprovementModel cannot be combined with clearSkillImprovementModel",
      },
      {
        code: "validation_failed",
        source: "session",
        message: "toolOutputOverflowChars cannot be combined with clearToolOutputOverflowChars",
      },
    ]);
  });

  test("blank titles fail closed and do not persist a rename", () => {
    const { context, errors, persistedReasons } = makeContext();
    const manager = new SessionMetadataManager(context);

    manager.setSessionTitle("   ");
    manager.setSessionTitle("");

    expect(context.state.hasGeneratedTitle).toBe(false);
    expect(context.state.sessionInfo.title).toBe("New Session");
    expect(context.state.sessionInfo.titleSource).toBe("default");
    expect(persistedReasons).toEqual([]);
    expect(errors).toEqual([
      { code: "validation_failed", source: "session", message: "Title must be non-empty" },
      { code: "validation_failed", source: "session", message: "Title must be non-empty" },
    ]);
  });
});
