import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import type { getAiCoworkerPaths } from "../../src/connect";
import type { SessionEvent } from "../../src/server/protocol";
import { ProviderAuthManager } from "../../src/server/session/ProviderAuthManager";
import type {
  AgentConfig,
  ProviderName,
  ServerErrorCode,
  ServerErrorSource,
} from "../../src/types";

const makeConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  provider: "google",
  model: "gemini-3-flash-preview",
  preferredChildModel: "gemini-3-flash-preview",
  workingDirectory: "/tmp/project",
  userName: "",
  knowledgeCutoff: "unknown",
  projectCoworkDir: "/tmp/project/.cowork",
  userCoworkDir: "/tmp/home/.cowork",
  builtInDir: "/tmp/project",
  builtInConfigDir: "/tmp/project/config",
  skillsDirs: [],
  memoryDirs: [],
  configDirs: [],
  enableMcp: true,
  ...overrides,
});

function makeManager(opts?: {
  config?: AgentConfig;
  running?: boolean;
  guardBusy?: () => boolean;
}) {
  let config = opts?.config ?? makeConfig();
  const events: SessionEvent[] = [];
  const errors: Array<{ code: ServerErrorCode; source: ServerErrorSource; message: string }> = [];
  const telemetry: Array<{
    name: string;
    status: "ok" | "error";
    attributes?: Record<string, string | number | boolean>;
  }> = [];
  let connecting = false;
  let clearedProviderState = 0;
  const persistModelSelection = mock(async () => {});
  const queuePersistSessionSnapshot = mock((_reason: string) => {});
  const emitConfigUpdated = mock(() => {});
  const emitProviderCatalog = mock(async () => {});
  const refreshProviderStatus = mock(async () => {});
  const updateSessionInfo = mock(() => {});
  const runProviderConnect = mock(async () => ({
    ok: true,
    provider: "openai" as ProviderName,
    mode: "api_key" as const,
    message: "ok",
  }));

  const manager = new ProviderAuthManager({
    sessionId: "session-1",
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    isRunning: () => opts?.running ?? false,
    guardBusy: opts?.guardBusy ?? (() => true),
    setConnecting: (next) => {
      connecting = next;
    },
    emit: (evt) => events.push(evt),
    emitError: (code, source, message) => errors.push({ code, source, message }),
    emitTelemetry: (name, status, attributes) => telemetry.push({ name, status, attributes }),
    formatError: (err) => String(err),
    log: () => {},
    clearProviderState: () => {
      clearedProviderState += 1;
    },
    persistModelSelection,
    updateSessionInfo,
    queuePersistSessionSnapshot,
    emitConfigUpdated,
    emitProviderCatalog,
    refreshProviderStatus,
    getGlobalAuthPaths: (): ReturnType<typeof getAiCoworkerPaths> => ({
      rootDir: "/tmp/home/.cowork",
      authDir: "/tmp/home/.cowork/auth",
      configDir: "/tmp/home/.cowork/config",
      sessionsDir: "/tmp/home/.cowork/sessions",
      logsDir: "/tmp/home/.cowork/logs",
      skillsDir: "/tmp/home/.cowork/skills",
      memoriesDir: "/tmp/home/.cowork/memories",
      connectionsFile: "/tmp/home/.cowork/auth/connections.json",
    }),
    runProviderConnect: runProviderConnect as any,
  });

  return {
    manager,
    events,
    errors,
    telemetry,
    get connecting() {
      return connecting;
    },
    get clearedProviderState() {
      return clearedProviderState;
    },
    get config() {
      return config;
    },
    persistModelSelection,
    queuePersistSessionSnapshot,
    emitConfigUpdated,
    emitProviderCatalog,
    refreshProviderStatus,
    updateSessionInfo,
    runProviderConnect,
  };
}

describe("ProviderAuthManager", () => {
  test("prepareModelSelection rejects blank and unsupported providers and clears state on switch", async () => {
    const harness = makeManager();

    expect(await harness.manager.prepareModelSelection("   ")).toBeNull();
    expect(
      await harness.manager.prepareModelSelection("gemini-3-flash-preview", "nope" as any),
    ).toBeNull();
    expect(harness.errors.map((error) => error.message)).toEqual([
      "Model id is required",
      "Unsupported provider: nope",
    ]);
    expect(harness.config.model).toBe("gemini-3-flash-preview");

    const prepared = await harness.manager.prepareModelSelection("gemini-3.1-flash-lite");
    expect(prepared).not.toBeNull();
    await harness.manager.applyPreparedModelSelection(prepared!);

    expect(harness.clearedProviderState).toBe(1);
    expect(harness.config.model).toBe("gemini-3.1-flash-lite");
    expect(path.basename(harness.config.userCoworkDir)).toBe(".cowork");
  });

  test("setModel enforces busy gate, no-ops when unchanged, and reports persist failures", async () => {
    const busy = makeManager({ running: true });
    await busy.manager.setModel("gemini-3.1-flash-lite");
    expect(busy.errors).toEqual([{ code: "busy", source: "session", message: "Agent is busy" }]);
    expect(busy.persistModelSelection).not.toHaveBeenCalled();

    const harness = makeManager();
    await harness.manager.setModel("gemini-3-flash-preview", "google");
    harness.persistModelSelection.mockClear();
    harness.telemetry.length = 0;

    await harness.manager.setModel("gemini-3-flash-preview", "google");
    expect(harness.errors).toEqual([]);
    expect(harness.persistModelSelection).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([
      expect.objectContaining({
        name: "session.defaults.noop",
        status: "ok",
        attributes: expect.objectContaining({ operation: "set_model" }),
      }),
    ]);

    harness.persistModelSelection.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    await harness.manager.setModel("gemini-3.1-flash-lite");
    expect(harness.config.model).toBe("gemini-3.1-flash-lite");
    expect(harness.config.preferredChildModel).toBe("gemini-3.1-flash-lite");
    expect(harness.emitConfigUpdated).toHaveBeenCalled();
    expect(harness.updateSessionInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", model: "gemini-3.1-flash-lite" }),
      undefined,
    );
    expect(harness.queuePersistSessionSnapshot).toHaveBeenCalledWith("session.model_updated");
    expect(harness.errors).toEqual([
      {
        code: "internal_error",
        source: "session",
        message: "Model updated for this session, but failed to persist defaults: Error: disk full",
      },
    ]);
  });

  test("provider auth mutations validate inputs and respect busy gates before connecting", async () => {
    const blocked = makeManager({ guardBusy: () => false });
    await blocked.manager.authorizeProviderAuth("codex-cli", "oauth_cli");
    expect(blocked.events).toEqual([]);
    expect(blocked.errors).toEqual([]);

    const harness = makeManager();
    await harness.manager.authorizeProviderAuth("openai", "   ");
    await harness.manager.authorizeProviderAuth("openai", "oauth_cli");
    await harness.manager.callbackProviderAuth("codex-cli", "\t");
    await harness.manager.setProviderApiKey("openai", " ", "sk-test");
    await harness.manager.setProviderConfig("openai", "aws_default", {});
    await harness.manager.logoutProviderAuth("not-a-provider" as ProviderName);

    expect(harness.events.filter((event) => event.type === "provider_auth_challenge")).toEqual([]);
    expect(harness.runProviderConnect).not.toHaveBeenCalled();
    expect(harness.refreshProviderStatus).not.toHaveBeenCalled();
    expect(harness.connecting).toBe(false);
    expect(harness.errors).toEqual([
      { code: "validation_failed", source: "provider", message: "Auth method id is required" },
      {
        code: "validation_failed",
        source: "provider",
        message: 'Unsupported auth method "oauth_cli" for openai.',
      },
      { code: "validation_failed", source: "provider", message: "Auth method id is required" },
      { code: "validation_failed", source: "provider", message: "Auth method id is required" },
      {
        code: "validation_failed",
        source: "provider",
        message: 'Unsupported auth method "aws_default" for openai.',
      },
      {
        code: "validation_failed",
        source: "provider",
        message: "Unsupported provider: not-a-provider",
      },
    ]);
  });

  test("copyProviderApiKey only allows OpenCode sibling pairs and valid source providers", async () => {
    const harness = makeManager();

    await harness.manager.copyProviderApiKey("openai", "anthropic");
    await harness.manager.copyProviderApiKey("opencode-zen", "openai");
    await harness.manager.copyProviderApiKey("opencode-zen", "opencode-zen");
    await harness.manager.copyProviderApiKey("opencode-zen", "not-a-provider" as ProviderName);

    expect(harness.runProviderConnect).not.toHaveBeenCalled();
    const siblingMessage =
      "provider_auth_copy_api_key only supports copying between OpenCode Go and OpenCode Zen.";
    expect(harness.errors.map((error) => error.message)).toEqual([
      siblingMessage,
      siblingMessage,
      siblingMessage,
      "Unsupported source provider: not-a-provider",
    ]);
  });
});
