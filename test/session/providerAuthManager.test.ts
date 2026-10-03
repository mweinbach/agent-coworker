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

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
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
  };
}

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
    emit: (evt) => {
      events.push(evt);
    },
    emitError: (code, source, message) => {
      errors.push({ code, source, message });
    },
    emitTelemetry: (name, status, attributes) => {
      telemetry.push({ name, status, attributes });
    },
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
  test("prepareModelSelection rejects blank and unsupported providers without mutating config", async () => {
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
  });

  test("setModel emits busy and skips preparation while a turn is running", async () => {
    const harness = makeManager({ running: true });

    await harness.manager.setModel("gemini-3.1-flash-lite");

    expect(harness.errors).toEqual([{ code: "busy", source: "session", message: "Agent is busy" }]);
    expect(harness.persistModelSelection).not.toHaveBeenCalled();
    expect(harness.config.model).toBe("gemini-3-flash-preview");
  });

  test("setModel no-ops when the selected model is already active", async () => {
    const harness = makeManager();

    // First call may normalize child-routing refs onto the live config.
    await harness.manager.setModel("gemini-3-flash-preview", "google");
    harness.persistModelSelection.mockClear();
    harness.telemetry.length = 0;
    harness.errors.length = 0;

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
  });

  test("setModel updates the session model and reports persist failures after applying", async () => {
    const harness = makeManager();
    harness.persistModelSelection.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    await harness.manager.setModel("gemini-3.1-flash-lite");

    expect(harness.config.model).toBe("gemini-3.1-flash-lite");
    expect(harness.config.preferredChildModel).toBe("gemini-3.1-flash-lite");
    expect(harness.emitConfigUpdated).toHaveBeenCalledTimes(1);
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

  test("authorizeProviderAuth rejects blank and unknown method ids before issuing a challenge", async () => {
    const harness = makeManager();

    await harness.manager.authorizeProviderAuth("openai", "   ");
    await harness.manager.authorizeProviderAuth("openai", "oauth_cli");

    expect(harness.events.filter((event) => event.type === "provider_auth_challenge")).toEqual([]);
    expect(harness.errors.map((error) => error.message)).toEqual([
      "Auth method id is required",
      'Unsupported auth method "oauth_cli" for openai.',
    ]);
  });

  test("authorizeProviderAuth respects the busy gate", async () => {
    const harness = makeManager({ guardBusy: () => false });

    await harness.manager.authorizeProviderAuth("codex-cli", "oauth_cli");

    expect(harness.events).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  test("callbackProviderAuth rejects blank method ids and never connects", async () => {
    const harness = makeManager();

    await harness.manager.callbackProviderAuth("codex-cli", "\t");

    expect(harness.runProviderConnect).not.toHaveBeenCalled();
    expect(harness.connecting).toBe(false);
    expect(harness.errors).toEqual([
      {
        code: "validation_failed",
        source: "provider",
        message: "Auth method id is required",
      },
    ]);
  });

  test("setProviderApiKey rejects blank method ids without connecting", async () => {
    const harness = makeManager();

    await harness.manager.setProviderApiKey("openai", " ", "sk-test");

    expect(harness.runProviderConnect).not.toHaveBeenCalled();
    expect(harness.connecting).toBe(false);
    expect(harness.errors).toEqual([
      {
        code: "validation_failed",
        source: "provider",
        message: "Auth method id is required",
      },
    ]);
  });

  test("setProviderConfig rejects unknown method ids without connecting", async () => {
    const harness = makeManager();

    await harness.manager.setProviderConfig("openai", "aws_default", {});

    expect(harness.runProviderConnect).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([
      {
        code: "validation_failed",
        source: "provider",
        message: 'Unsupported auth method "aws_default" for openai.',
      },
    ]);
  });

  test("copyProviderApiKey only allows OpenCode sibling pairs", async () => {
    const harness = makeManager();

    await harness.manager.copyProviderApiKey("openai", "anthropic");
    await harness.manager.copyProviderApiKey("opencode-zen", "openai");
    await harness.manager.copyProviderApiKey("opencode-zen", "opencode-zen");

    expect(harness.runProviderConnect).not.toHaveBeenCalled();
    expect(harness.errors.map((error) => error.message)).toEqual([
      "provider_auth_copy_api_key only supports copying between OpenCode Go and OpenCode Zen.",
      "provider_auth_copy_api_key only supports copying between OpenCode Go and OpenCode Zen.",
      "provider_auth_copy_api_key only supports copying between OpenCode Go and OpenCode Zen.",
    ]);
  });

  test("copyProviderApiKey rejects unsupported source providers before connect", async () => {
    const harness = makeManager();

    await harness.manager.copyProviderApiKey("opencode-zen", "not-a-provider" as ProviderName);

    expect(harness.runProviderConnect).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([
      {
        code: "validation_failed",
        source: "provider",
        message: "Unsupported source provider: not-a-provider",
      },
    ]);
  });

  test("logoutProviderAuth rejects unsupported providers without connecting", async () => {
    const harness = makeManager();

    await harness.manager.logoutProviderAuth("not-a-provider" as ProviderName);

    expect(harness.connecting).toBe(false);
    expect(harness.refreshProviderStatus).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([
      {
        code: "validation_failed",
        source: "provider",
        message: "Unsupported provider: not-a-provider",
      },
    ]);
  });

  test("prepareModelSelection clears provider state when switching models", async () => {
    const harness = makeManager({
      config: makeConfig({
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
      }),
    });

    const prepared = await harness.manager.prepareModelSelection("gemini-3.1-flash-lite");
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    await harness.manager.applyPreparedModelSelection(prepared);

    expect(harness.clearedProviderState).toBe(1);
    expect(harness.config.model).toBe("gemini-3.1-flash-lite");
    expect(path.basename(harness.config.userCoworkDir)).toBe(".cowork");
  });
});
