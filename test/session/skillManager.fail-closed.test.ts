import { describe, expect, test } from "bun:test";
import type { SessionContext } from "../../src/server/session/SessionContext";
import { SkillManager } from "../../src/server/session/SkillManager";
import type {
  SendUserMessageOptions,
  UserMessageAdmission,
} from "../../src/server/session/TurnExecutionManager";

type EmittedError = { code: string; source: string; message: string };

function makeHarness(overrides: Partial<SessionContext["state"]> = {}) {
  const errors: EmittedError[] = [];
  const sent: Array<{ text: string; clientMessageId?: string; displayText?: string }> = [];
  const forwarded: Array<SendUserMessageOptions | undefined> = [];
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
        command: { empty: { template: "$ARGUMENTS" } },
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
      ...overrides,
    },
    deps: {},
    emit: () => {},
    emitError: (code: string, source: string, message: string) =>
      errors.push({ code, source, message }),
    emitTelemetry: () => {},
    getSkillMutationBlockReason: () => null,
    refreshSkillsAcrossWorkspaceSessions: async () => {},
    emitMcpServers: async () => {},
  } as SessionContext;
  const manager = new SkillManager(context, {
    sendUserMessage: async (
      text,
      clientMessageId,
      displayText,
      _attachments,
      _inputParts,
      _references,
      opts,
    ) => {
      sent.push({ text, clientMessageId, displayText });
      forwarded.push(opts);
    },
  });
  return { context, errors, sent, forwarded, manager };
}

describe("SkillManager fail-closed gates", () => {
  test("executeCommand rejects blank, unknown, and empty expansions without sending", async () => {
    const { errors, sent, manager } = makeHarness();

    await manager.executeCommand("   ");
    await manager.executeCommand("definitely-missing");
    await manager.executeCommand("empty");

    expect(sent).toEqual([]);
    expect(errors).toEqual([
      { code: "validation_failed", source: "session", message: "Command name is required" },
      {
        code: "validation_failed",
        source: "session",
        message: "Unknown command: definitely-missing",
      },
      {
        code: "validation_failed",
        source: "session",
        message: 'Command "empty" expanded to empty prompt',
      },
    ]);
  });

  test("executeCommand rejects validation failures through onAdmission and forwards accepted commands", async () => {
    const { sent, forwarded, manager } = makeHarness();
    const admissions: UserMessageAdmission[] = [];
    const opts: SendUserMessageOptions = {
      onAdmission: (outcome) => {
        admissions.push(outcome);
      },
    };

    await manager.executeCommand("   ", "", "client-blank", opts);
    await manager.executeCommand("definitely-missing", "", "client-unknown", opts);
    await manager.executeCommand("empty", "   ", "client-empty", opts);
    await manager.executeCommand("empty", "hello", "client-ok", opts);

    expect(sent).toEqual([
      { text: "hello", clientMessageId: "client-ok", displayText: "/empty hello" },
    ]);
    expect(forwarded).toEqual([opts]);
    expect(admissions).toEqual([
      {
        status: "rejected",
        error: {
          type: "error",
          sessionId: "session-1",
          code: "validation_failed",
          source: "session",
          message: "Command name is required",
        },
      },
      {
        status: "rejected",
        error: {
          type: "error",
          sessionId: "session-1",
          code: "validation_failed",
          source: "session",
          message: "Unknown command: definitely-missing",
        },
      },
      {
        status: "rejected",
        error: {
          type: "error",
          sessionId: "session-1",
          code: "validation_failed",
          source: "session",
          message: 'Command "empty" expanded to empty prompt',
        },
      },
    ]);
  });

  test("blank skill, plugin, marketplace, and installation ids fail before lookup", async () => {
    const { errors, manager } = makeHarness();

    await manager.readSkill("  ");
    await manager.disableSkill("");
    await manager.enablePlugin("   ");
    await manager.addMarketplace("");
    await manager.readMarketplaceDetail(" ");
    await manager.getSkillInstallation("\t");

    expect(errors).toEqual([
      { code: "validation_failed", source: "session", message: "Skill name is required" },
      { code: "validation_failed", source: "session", message: "Skill name is required" },
      { code: "validation_failed", source: "session", message: "Plugin ID is required" },
      { code: "validation_failed", source: "session", message: "Marketplace source is required" },
      { code: "validation_failed", source: "session", message: "Marketplace ID is required" },
      { code: "validation_failed", source: "session", message: "Installation ID is required" },
    ]);
  });

  test("skill mutations short-circuit when the agent is busy or mutations are blocked", async () => {
    const busy = makeHarness({ running: true });
    await busy.manager.disableSkill("alpha");
    expect(busy.errors).toEqual([{ code: "busy", source: "session", message: "Agent is busy" }]);

    const blocked = makeHarness();
    blocked.context.getSkillMutationBlockReason = () => "Skill catalog is refreshing";
    await blocked.manager.enableSkill("alpha");
    expect(blocked.errors).toEqual([
      { code: "busy", source: "session", message: "Skill catalog is refreshing" },
    ]);
  });
});
