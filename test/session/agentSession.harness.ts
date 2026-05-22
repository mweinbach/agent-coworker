import { mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as REAL_AGENT from "../../src/agent";
import {
  createExperimentalA2uiSurfaceManager,
  deriveA2uiSurfacesFromSnapshot,
} from "../../src/experimental/a2ui/sessionAdapter";
import { defaultSupportedModel, getSupportedModel } from "../../src/models/registry";
import { __internal as observabilityRuntimeInternal } from "../../src/observability/runtime";
import { createRuntime } from "../../src/runtime";
import { ASK_SKIP_TOKEN, type SessionEvent } from "../../src/server/protocol";
import type { SessionInfoState } from "../../src/server/session/SessionContext";
import type {
  SessionBackupHandle,
  SessionBackupInitOptions,
  SessionBackupPublicCheckpoint,
  SessionBackupPublicState,
} from "../../src/server/sessionBackup";
import { SessionCostTracker } from "../../src/session/costTracker";
import {
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
} from "../../src/shared/attachments";
import type { AgentConfig, TodoItem } from "../../src/types";

export {
  REAL_AGENT,
  ASK_SKIP_TOKEN,
  SessionCostTracker,
  createExperimentalA2uiSurfaceManager,
  deriveA2uiSurfacesFromSnapshot,
  createRuntime,
  defaultSupportedModel,
  getSupportedModel,
  fs,
  os,
  path,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
};
export type { TodoItem };

const mockRunTurn = mock(async () => ({
  text: "",
  reasoningText: undefined as string | undefined,
  responseMessages: [] as any[],
}));

mock.module("../../src/agent", () => ({
  ...REAL_AGENT,
  runTurn: mockRunTurn,
}));

export { mockRunTurn };

async function withEnv<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

export { withEnv };

export const mockConnectModelProvider = mock(
  async (_opts: any): Promise<any> => ({
    ok: true,
    provider: "openai",
    mode: "api_key",
    storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
    message: "Provider key saved.",
    maskedApiKey: "sk-t...est",
  }),
);

export const mockGetAiCoworkerPaths = mock((opts?: { homedir?: string }) => {
  const home = opts?.homedir ?? "/tmp/mock-home";
  const rootDir = path.join(home, ".cowork");
  const authDir = path.join(rootDir, "auth");
  return {
    rootDir,
    authDir,
    configDir: path.join(rootDir, "config"),
    sessionsDir: path.join(rootDir, "sessions"),
    logsDir: path.join(rootDir, "logs"),
    skillsDir: path.join(rootDir, "skills"),
    connectionsFile: path.join(authDir, "connections.json"),
  };
});

export const mockGenerateSessionTitle = mock(async () => ({
  title: "Mock title",
  source: "heuristic" as const,
  model: null as string | null,
}));

export const mockWritePersistedSessionSnapshot = mock(
  async () => "/tmp/mock-home/.cowork/sessions/mock.json",
);

export const mockClosePooledCodexAppServerClient = mock(async () => {});

const codexResolvedPath = path.resolve("src/providers/codexAppServerClient");
mock.module(codexResolvedPath, () => ({
  closePooledCodexAppServerClient: mockClosePooledCodexAppServerClient,
}));
mock.module(`${codexResolvedPath}.ts`, () => ({
  closePooledCodexAppServerClient: mockClosePooledCodexAppServerClient,
}));
mock.module("../../src/providers/codexAppServerClient", () => ({
  closePooledCodexAppServerClient: mockClosePooledCodexAppServerClient,
}));

const { AgentSession } = await import("../../src/server/session/AgentSession");
export { AgentSession };

export function makeConfig(dir: string): AgentConfig {
  const userCoworkDir = path.join(dir, ".agent-user");
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir,
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [path.join(path.dirname(userCoworkDir), ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function makeEmit(): { emit: (evt: SessionEvent) => void; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const emit = (event: SessionEvent) => {
    events.push(event);
  };
  return { emit, events };
}

export function makeSessionBackupFactory() {
  return mock(async (opts: SessionBackupInitOptions): Promise<SessionBackupHandle> => {
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
      restoreOriginal: async () => {},
      restoreCheckpoint: async (checkpointId) => {
        if (!checkpoints.some((cp) => cp.id === checkpointId)) {
          throw new Error(`Unknown checkpoint: ${checkpointId}`);
        }
      },
      deleteCheckpoint: async (checkpointId) => {
        const idx = checkpoints.findIndex((cp) => cp.id === checkpointId);
        if (idx < 0) return false;
        checkpoints.splice(idx, 1);
        return true;
      },
      reloadFromDisk: async () => getState(),
      close: async () => {},
    };
  });
}

export function makeSession(
  overrides?: Partial<{
    config: AgentConfig;
    system: string;
    yolo: boolean;
    emit: (evt: SessionEvent) => void;
    connectProviderImpl: (opts: any) => Promise<any>;
    getAiCoworkerPathsImpl: (opts?: { homedir?: string }) => {
      rootDir: string;
      configDir: string;
      sessionsDir: string;
      logsDir: string;
      connectionsFile: string;
    };
    getProviderCatalogImpl: (opts: any) => Promise<any>;
    getProviderStatusesImpl: (opts: any) => Promise<any>;
    sessionBackupFactory: (opts: SessionBackupInitOptions) => Promise<SessionBackupHandle>;
    persistModelSelectionImpl: (selection: {
      provider: AgentConfig["provider"];
      model: string;
      preferredChildModel: string;
    }) => Promise<void> | void;
    persistProjectConfigPatchImpl: (
      patch: Partial<
        Pick<
          AgentConfig,
          | "provider"
          | "model"
          | "preferredChildModel"
          | "enableMcp"
          | "enableA2ui"
          | "enableMemory"
          | "memoryRequireApproval"
          | "observabilityEnabled"
          | "backupsEnabled"
          | "toolOutputOverflowChars"
          | "userName"
          | "featureFlags"
        >
      > & {
        userProfile?: Partial<NonNullable<AgentConfig["userProfile"]>>;
        clearToolOutputOverflowChars?: boolean;
      },
    ) => Promise<void> | void;
    loadSystemPromptWithSkillsImpl: (config: AgentConfig) => Promise<{
      prompt: string;
      discoveredSkills: Array<{ name: string; description: string }>;
    }>;
    generateSessionTitleImpl: (opts: { config: AgentConfig; query: string }) => Promise<{
      title: string;
      source: "default" | "model" | "heuristic";
      model: string | null;
    }>;
    writePersistedSessionSnapshotImpl: (opts: any) => Promise<string>;
    createAgentSessionImpl: (opts: any) => Promise<any>;
    listAgentSessionsImpl: (parentSessionId: string) => Promise<any[]>;
    sendAgentInputImpl: (opts: any) => Promise<void>;
    waitForAgentImpl: (opts: any) => Promise<any>;
    closeAgentImpl: (opts: any) => Promise<any>;
    cancelAgentSessionsImpl: (parentSessionId: string) => void;
    deleteSessionImpl: (opts: any) => Promise<void>;
    getSkillMutationBlockReasonImpl: (workingDirectory: string) => string | null;
    readSkillCatalogMtimeSnapshotImpl: (config: AgentConfig) => Promise<string>;
    refreshSkillsAcrossWorkspaceSessionsImpl: (opts: {
      workingDirectory: string;
      sourceSessionId: string;
      allWorkspaces?: boolean;
    }) => Promise<void>;
    sessionInfoPatch: Partial<SessionInfoState>;
    discoveredSkills: Array<{ name: string; description: string }>;
    initialSkillCatalogMtimeSnapshot: string | null;
  }>,
) {
  const dir = "/tmp/test-session";
  const { emit, events } = makeEmit();
  const sessionBackupFactory = overrides?.sessionBackupFactory ?? makeSessionBackupFactory();
  const getProviderStatusesImpl = overrides?.getProviderStatusesImpl ?? (async () => []);
  const discoveredSkills =
    overrides && "discoveredSkills" in overrides
      ? overrides.discoveredSkills
      : [{ name: "test-skill", description: "Test skill" }];
  const session = new AgentSession({
    config: overrides?.config ?? makeConfig(dir),
    system: overrides?.system ?? "You are a test assistant.",
    discoveredSkills,
    yolo: overrides?.yolo,
    emit: overrides?.emit ?? emit,
    connectProviderImpl: overrides?.connectProviderImpl,
    getAiCoworkerPathsImpl: overrides?.getAiCoworkerPathsImpl,
    loadSystemPromptWithSkillsImpl: overrides?.loadSystemPromptWithSkillsImpl,
    getProviderCatalogImpl: overrides?.getProviderCatalogImpl as any,
    getProviderStatusesImpl,
    sessionBackupFactory,
    persistModelSelectionImpl: overrides?.persistModelSelectionImpl,
    persistProjectConfigPatchImpl: overrides?.persistProjectConfigPatchImpl,
    generateSessionTitleImpl: overrides?.generateSessionTitleImpl ?? mockGenerateSessionTitle,
    writePersistedSessionSnapshotImpl:
      overrides?.writePersistedSessionSnapshotImpl ?? mockWritePersistedSessionSnapshot,
    createAgentSessionImpl: overrides?.createAgentSessionImpl,
    listAgentSessionsImpl: overrides?.listAgentSessionsImpl,
    sendAgentInputImpl: overrides?.sendAgentInputImpl,
    waitForAgentImpl: overrides?.waitForAgentImpl,
    closeAgentImpl: overrides?.closeAgentImpl,
    cancelAgentSessionsImpl: overrides?.cancelAgentSessionsImpl,
    deleteSessionImpl: overrides?.deleteSessionImpl,
    getSkillMutationBlockReasonImpl: overrides?.getSkillMutationBlockReasonImpl,
    readSkillCatalogMtimeSnapshotImpl: overrides?.readSkillCatalogMtimeSnapshotImpl,
    refreshSkillsAcrossWorkspaceSessionsImpl: overrides?.refreshSkillsAcrossWorkspaceSessionsImpl,
    initialSkillCatalogMtimeSnapshot: overrides?.initialSkillCatalogMtimeSnapshot,
    sessionInfoPatch: overrides?.sessionInfoPatch,
  });
  return { session, emit, events, sessionBackupFactory };
}

export async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await flushAsyncWork();
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

export async function resetAgentSessionMocks(): Promise<void> {
  await observabilityRuntimeInternal.resetForTests();

  mockRunTurn.mockReset();
  mockClosePooledCodexAppServerClient.mockClear();
  mockRunTurn.mockImplementation(async () => ({
    text: "",
    reasoningText: undefined,
    responseMessages: [],
  }));

  mockConnectModelProvider.mockReset();
  mockConnectModelProvider.mockImplementation(async () => ({
    ok: true,
    provider: "openai",
    mode: "api_key",
    storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
    message: "Provider key saved.",
    maskedApiKey: "sk-t...est",
  }));

  mockGetAiCoworkerPaths.mockReset();
  mockGetAiCoworkerPaths.mockImplementation((opts?: { homedir?: string }) => {
    const home = opts?.homedir ?? "/tmp/mock-home";
    const rootDir = path.join(home, ".cowork");
    const authDir = path.join(rootDir, "auth");
    return {
      rootDir,
      authDir,
      configDir: path.join(rootDir, "config"),
      sessionsDir: path.join(rootDir, "sessions"),
      logsDir: path.join(rootDir, "logs"),
      skillsDir: path.join(rootDir, "skills"),
      connectionsFile: path.join(authDir, "connections.json"),
    };
  });

  mockGenerateSessionTitle.mockReset();
  mockGenerateSessionTitle.mockImplementation(async () => ({
    title: "Mock title",
    source: "heuristic",
    model: null,
  }));

  mockWritePersistedSessionSnapshot.mockReset();
  mockWritePersistedSessionSnapshot.mockImplementation(
    async () => "/tmp/mock-home/.cowork/sessions/mock.json",
  );
}
