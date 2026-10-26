import { describe, expect, test } from "bun:test";
import type { SessionContext } from "../../src/server/session/SessionContext";
import { SkillManager } from "../../src/server/session/SkillManager";
import type {
  SendUserMessageOptions,
  UserMessageAdmission,
} from "../../src/server/session/TurnExecutionManager";

type EmittedError = { code: string; source: string; message: string };
type SentCommand = {
  text: string;
  clientMessageId?: string;
  displayText?: string;
  opts?: SendUserMessageOptions;
};

function rejectedAdmission(message: string): UserMessageAdmission {
  return {
    status: "rejected",
    error: {
      type: "error",
      sessionId: "session-1",
      code: "validation_failed",
      source: "session",
      message,
    },
  };
}

function makeHarness(overrides: Partial<SessionContext["state"]> = {}) {
  const errors: EmittedError[] = [];
  const sent: SentCommand[] = [];
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
        command: {
          empty: { template: "$ARGUMENTS" },
          ghost: { template: " \t " },
          summarize: { template: "Summarize:\n$ARGUMENTS" },
        },
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
      sent.push({ text, clientMessageId, displayText, opts });
    },
  });
  return { context, errors, sent, manager };
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

  test("executeCommand admits validation failures and forwards a real command unchanged", async () => {
    const { errors, sent, manager } = makeHarness();
    const admissions: UserMessageAdmission[] = [];
    const opts: SendUserMessageOptions = {
      allowThreadManagementTools: false,
      idempotencyClaim: null,
      onAdmission: (outcome) => admissions.push(outcome),
    };

    await manager.executeCommand("   ", "ignored", "client-blank", opts);
    await manager.executeCommand("definitely-missing", "", "client-missing", opts);
    await manager.executeCommand(" ghost ", "args", "client-ghost", opts);
    await manager.executeCommand("  EMPTY  ", "   ", "client-empty", opts);

    expect(sent).toEqual([]);
    expect(admissions).toEqual([
      rejectedAdmission("Command name is required"),
      rejectedAdmission("Unknown command: definitely-missing"),
      rejectedAdmission("Unknown command: ghost"),
      rejectedAdmission('Command "EMPTY" expanded to empty prompt'),
    ]);
    expect(errors).toEqual(
      admissions.flatMap((outcome) =>
        outcome.status === "rejected"
          ? [
              {
                code: outcome.error.code,
                source: outcome.error.source,
                message: outcome.error.message,
              },
            ]
          : [],
      ),
    );

    admissions.length = 0;
    errors.length = 0;
    await manager.executeCommand("  Summarize  ", "  notes $1  ", "client-9", opts);

    expect(admissions).toEqual([]);
    expect(errors).toEqual([]);
    expect(sent).toEqual([
      {
        text: "Summarize:\nnotes $1",
        clientMessageId: "client-9",
        displayText: "/summarize notes $1",
        opts,
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
