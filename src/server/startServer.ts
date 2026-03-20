import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getAiCoworkerPaths as getAiCoworkerPathsDefault } from "../connect";
import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../connect";
import type { runTurn as runTurnFn } from "../agent";
import { defaultRuntimeNameForProvider, type AgentConfig } from "../types";
import { loadConfig } from "../config";
import { emitObservabilityEvent } from "../observability/otel";
import { loadAgentPrompt, loadSystemPromptWithSkills } from "../prompt";
import type { OpenAiCompatibleProviderOptionsByProvider } from "../shared/openaiCompatibleOptions";
import type { SessionKind } from "../shared/agents";
import {
  EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES,
  mergeEditableOpenAiCompatibleProviderOptions,
} from "../shared/openaiCompatibleOptions";
import { ensureDefaultGlobalSkillsReady } from "../skills/defaultGlobalSkills";
import { writeTextFileAtomic } from "../utils/atomicFile";
import { getProviderCatalog } from "../providers/connectionCatalog";
import { resolveAuthHomeDir } from "../utils/authHome";

import { AgentControl } from "./agents/AgentControl";
import { AgentSession } from "./session/AgentSession";
import { createLegacySessionSnapshot } from "./session/SessionSnapshotProjector";
import { SessionDb, type PersistedSessionRecord } from "./sessionDb";
import { WorkspaceBackupService } from "./workspaceBackups";
import {
  WEBSOCKET_PROTOCOL_VERSION,
  type ServerEvent,
} from "./protocol";
import { decodeClientMessage } from "./startServer/decodeClientMessage";
import { dispatchClientMessage } from "./startServer/dispatchClientMessage";
import { type SessionBinding, type StartServerSocketData } from "./startServer/types";
import type { SeededSessionContext, SessionDependencies, SessionInfoState } from "./session/SessionContext";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const errorWithCodeSchema = z.object({
  code: z.string().optional(),
}).passthrough();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return jsonObjectSchema.safeParse(v).success;
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: T): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

async function loadJsonObjectSafe(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in config file ${filePath}: ${String(error)}`);
    }
    const parsedObject = jsonObjectSchema.safeParse(parsedJson);
    if (!parsedObject.success) {
      throw new Error(`Config file must contain a JSON object: ${filePath}`);
    }
    return parsedObject.data;
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return {};
    if (error instanceof Error) throw error;
    throw new Error(`Failed to load config file ${filePath}: ${String(error)}`);
  }
}

async function persistProjectConfigPatch(
  projectAgentDir: string,
  patch: Partial<
    Pick<
      AgentConfig,
      | "provider"
      | "model"
      | "preferredChildModel"
      | "childModelRoutingMode"
      | "preferredChildModelRef"
      | "allowedChildModelRefs"
      | "enableMcp"
      | "enableMemory"
      | "memoryRequireApproval"
      | "observabilityEnabled"
      | "backupsEnabled"
      | "toolOutputOverflowChars"
      | "userName"
    >
  > & {
    userProfile?: Partial<NonNullable<AgentConfig["userProfile"]>>;
    clearToolOutputOverflowChars?: boolean;
    providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
  },
  runtimeProviderOptions?: AgentConfig["providerOptions"],
): Promise<void> {
  const entries = Object.entries(patch).filter(([key, value]) => key !== "clearToolOutputOverflowChars" && value !== undefined);
  const shouldClearToolOutputOverflowChars = patch.clearToolOutputOverflowChars === true;
  if (entries.length === 0 && !shouldClearToolOutputOverflowChars) return;
  const configPath = path.join(projectAgentDir, "config.json");
  const current = await loadJsonObjectSafe(configPath);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of entries) {
    if (key === "providerOptions") {
      const currentProviderOptions = isPlainObject(current[key]) ? { ...current[key] } : {};
      for (const provider of EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES) {
        const sectionPatch = patch.providerOptions?.[provider];
        if (!sectionPatch) continue;

        const runtimeSection =
          isPlainObject(runtimeProviderOptions) && isPlainObject(runtimeProviderOptions[provider])
            ? { ...runtimeProviderOptions[provider] }
            : {};
        const currentSection = isPlainObject(currentProviderOptions[provider])
          ? { ...currentProviderOptions[provider] }
          : {};

        // Merge order (lowest → highest priority):
        //   runtimeSection  — options passed at server startup (e.g. CLI flags or desktop launch config)
        //   currentSection  — previously persisted values in .agent/config.json
        //   sectionPatch    — the incoming patch from this set_config call
        // Launch-time options are intentionally overridable by persisted config and new patches so
        // that user changes made via the UI/CLI survive server restarts.
        currentProviderOptions[provider] = {
          ...runtimeSection,
          ...currentSection,
          ...sectionPatch,
        };
      }
      next[key] = Object.keys(currentProviderOptions).length > 0 ? currentProviderOptions : undefined;
      continue;
    }
    if (key === "userProfile" && isPlainObject(value)) {
      const currentUserProfile = isPlainObject(current.userProfile) ? current.userProfile : {};
      next[key] = {
        ...currentUserProfile,
        ...value,
      };
      continue;
    }
    next[key] = value;
  }
  if (shouldClearToolOutputOverflowChars) {
    delete next.toolOutputOverflowChars;
  }
  await fs.mkdir(projectAgentDir, { recursive: true });
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  await writeTextFileAtomic(configPath, payload);
}

function mergeConfigPatch(
  config: AgentConfig,
  patch: Partial<
    Pick<
      AgentConfig,
      | "provider"
      | "model"
      | "preferredChildModel"
      | "childModelRoutingMode"
      | "preferredChildModelRef"
      | "allowedChildModelRefs"
      | "enableMcp"
      | "enableMemory"
      | "memoryRequireApproval"
      | "observabilityEnabled"
      | "backupsEnabled"
      | "toolOutputOverflowChars"
      | "userName"
    >
  > & {
    userProfile?: Partial<NonNullable<AgentConfig["userProfile"]>>;
    clearToolOutputOverflowChars?: boolean;
    providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
  }
): AgentConfig {
  const { clearToolOutputOverflowChars: _clearToolOutputOverflowChars, ...configPatch } = patch;
  const next: AgentConfig = { ...config, ...configPatch };
  if (patch.provider !== undefined && patch.provider !== config.provider) {
    next.runtime = defaultRuntimeNameForProvider(patch.provider);
  }
  if (patch.toolOutputOverflowChars !== undefined) {
    next.projectConfigOverrides = {
      ...config.projectConfigOverrides,
      toolOutputOverflowChars: patch.toolOutputOverflowChars,
    };
  }
  if (patch.clearToolOutputOverflowChars) {
    const { toolOutputOverflowChars: _ignored, ...remainingOverrides } = config.projectConfigOverrides ?? {};
    next.toolOutputOverflowChars = config.inheritedToolOutputOverflowChars;
    next.projectConfigOverrides = Object.keys(remainingOverrides).length > 0 ? remainingOverrides : undefined;
  }
  if (patch.providerOptions !== undefined) {
    next.providerOptions = mergeEditableOpenAiCompatibleProviderOptions(config.providerOptions, patch.providerOptions);
  }
  if (patch.userProfile !== undefined) {
    next.userProfile = {
      ...config.userProfile,
      ...patch.userProfile,
    };
  }
  return next;
}

export interface StartAgentServerOptions {
  cwd: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string | undefined>;
  providerOptions?: Record<string, any>;
  yolo?: boolean;
  homedir?: string;
  connectProviderImpl?: typeof connectModelProvider;
  getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
  runTurnImpl?: typeof runTurnFn;
}

export async function startAgentServer(
  opts: StartAgentServerOptions
): Promise<{
  server: ReturnType<typeof Bun.serve>;
  config: AgentConfig;
  system: string;
  url: string;
}> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const rawEnv = opts.env ?? { ...process.env, AGENT_WORKING_DIR: opts.cwd };
  const env: Record<string, string | undefined> & {
    COWORK_BUILTIN_DIR?: string;
  } = { ...rawEnv };

  await ensureDefaultGlobalSkillsReady({
    homedir: opts.homedir,
    env,
    log: (line) => {
      console.warn(`[default-skills] ${line}`);
    },
  });

  const builtInDir =
    typeof env.COWORK_BUILTIN_DIR === "string" && env.COWORK_BUILTIN_DIR.trim()
      ? env.COWORK_BUILTIN_DIR
      : undefined;
  let config = await loadConfig({ cwd: opts.cwd, env, homedir: opts.homedir, builtInDir });
  const mergedProviderOptions =
    isPlainObject(opts.providerOptions) && isPlainObject(config.providerOptions)
      ? deepMerge(
          opts.providerOptions as Record<string, unknown>,
          config.providerOptions as Record<string, unknown>
        )
      : isPlainObject(config.providerOptions)
        ? config.providerOptions
        : isPlainObject(opts.providerOptions)
          ? opts.providerOptions
          : undefined;
  if (mergedProviderOptions) config.providerOptions = mergedProviderOptions;

  await fs.mkdir(config.projectAgentDir, { recursive: true });

  const { prompt: system, discoveredSkills } = await loadSystemPromptWithSkills(config);
  const getAiCoworkerPathsImpl = opts.getAiCoworkerPathsImpl ?? getAiCoworkerPathsDefault;
  const sessionDb = await SessionDb.create({
    paths: getAiCoworkerPathsImpl({ homedir: opts.homedir }),
    emitTelemetry: (name, status, attributes, durationMs) => {
      void emitObservabilityEvent(config, {
        name,
        at: new Date().toISOString(),
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
        attributes,
      }).catch(() => {
        // Session DB observability is best-effort only.
      });
    },
  });
  const sessionBindings = new Map<string, SessionBinding>();
  const workspaceBackupService = new WorkspaceBackupService({
    homedir: opts.homedir,
    sessionDb,
    getLiveSession: (sessionId) => {
      const session = sessionBindings.get(sessionId)?.session;
      if (!session) return null;
      const info = session.getSessionInfoEvent();
      return {
        sessionId: session.id,
        title: info.title,
        provider: info.provider,
        model: info.model,
        updatedAt: info.updatedAt,
        status: session.persistenceStatus,
        busy: session.isBusy,
        setBackupsEnabledOverride: async (enabled) => {
          await session.setBackupsEnabledOverride(enabled);
        },
        reloadBackupStateFromDisk: async () => {
          await session.reloadSessionBackupStateFromDisk();
        },
      };
    },
  });

  let agentControl: AgentControl;

  const buildSessionCommon = (binding: SessionBinding, sessionKind: SessionKind = "root") => {
    const emit = (evt: ServerEvent) => {
      const socket = binding.socket;
      if (!socket) return;
      try {
        socket.send(JSON.stringify(evt));
      } catch {
        // ignore
      }
    };

    return {
      discoveredSkills,
      yolo: opts.yolo,
      connectProviderImpl: opts.connectProviderImpl,
      getAiCoworkerPathsImpl,
      runTurnImpl: opts.runTurnImpl,
      persistModelSelectionImpl: sessionKind === "root"
        ? async (selection: {
            provider: AgentConfig["provider"];
            model: string;
            preferredChildModel: string;
            childModelRoutingMode?: import("../types").ChildModelRoutingMode;
            preferredChildModelRef?: string;
            allowedChildModelRefs?: string[];
          }) => {
            await persistProjectConfigPatch(config.projectAgentDir, selection, config.providerOptions);
            config = mergeConfigPatch(config, selection);
          }
        : undefined,
      persistProjectConfigPatchImpl: sessionKind === "root"
        ? async (
          patch: Partial<
            Pick<
              AgentConfig,
              | "provider"
              | "model"
              | "preferredChildModel"
              | "childModelRoutingMode"
              | "preferredChildModelRef"
              | "allowedChildModelRefs"
              | "enableMcp"
              | "enableMemory"
              | "memoryRequireApproval"
              | "observabilityEnabled"
              | "backupsEnabled"
              | "toolOutputOverflowChars"
            >
          > & {
            clearToolOutputOverflowChars?: boolean;
            providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
          }
        ) => {
            await persistProjectConfigPatch(config.projectAgentDir, patch, config.providerOptions);
            config = mergeConfigPatch(config, patch);
          }
        : undefined,
      sessionDb,
      emit,
      createAgentSessionImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["createAgentSessionImpl"]>>[0],
      ) => await agentControl.spawn(agentOpts),
      listAgentSessionsImpl: async (
        parentSessionId: Parameters<NonNullable<SessionDependencies["listAgentSessionsImpl"]>>[0],
      ) => await agentControl.list(parentSessionId),
      sendAgentInputImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["sendAgentInputImpl"]>>[0],
      ) => await agentControl.sendInput(agentOpts),
      waitForAgentImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["waitForAgentImpl"]>>[0],
      ) => await agentControl.wait(agentOpts),
      resumeAgentImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["resumeAgentImpl"]>>[0],
      ) => await agentControl.resume(agentOpts),
      closeAgentImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["closeAgentImpl"]>>[0],
      ) => await agentControl.close(agentOpts),
      cancelAgentSessionsImpl: (
        parentSessionId: Parameters<NonNullable<SessionDependencies["cancelAgentSessionsImpl"]>>[0],
      ) => agentControl.cancelAll(parentSessionId),
      deleteSessionImpl: async (opts: { requesterSessionId: string; targetSessionId: string }): Promise<void> => {
        void opts.requesterSessionId;
        const liveChildIds = [...sessionBindings.values()]
          .map((childBinding) => childBinding.session)
          .filter((session): session is AgentSession => !!session && session.isAgentOf(opts.targetSessionId))
          .map((session) => session.id);
        const persistedChildIds = sessionDb.listAgentSessions(opts.targetSessionId).map((summary) => summary.agentId);
        const sessionIdsToDispose = new Set([opts.targetSessionId, ...persistedChildIds, ...liveChildIds]);

        for (const sessionId of sessionIdsToDispose) {
          const candidateBinding = sessionBindings.get(sessionId);
          if (!candidateBinding?.session) continue;
          disposeBinding(candidateBinding, `session ${opts.targetSessionId} deleted`);
          sessionBindings.delete(sessionId);
        }

        await sessionDb.deleteSession(opts.targetSessionId);
      },
      listWorkspaceBackupsImpl: async (opts: { requesterSessionId: string; workingDirectory: string }) =>
        await workspaceBackupService.listWorkspaceBackups(opts.workingDirectory),
      createWorkspaceBackupCheckpointImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
      }) =>
        await workspaceBackupService.createCheckpoint(opts.workingDirectory, opts.targetSessionId),
      restoreWorkspaceBackupImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
        checkpointId?: string;
      }) =>
        await workspaceBackupService.restoreBackup(opts.workingDirectory, opts.targetSessionId, opts.checkpointId),
      deleteWorkspaceBackupCheckpointImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
        checkpointId: string;
      }) =>
        await workspaceBackupService.deleteCheckpoint(opts.workingDirectory, opts.targetSessionId, opts.checkpointId),
      deleteWorkspaceBackupEntryImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
      }) =>
        await workspaceBackupService.deleteEntry(opts.workingDirectory, opts.targetSessionId),
      getWorkspaceBackupDeltaImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
        checkpointId: string;
      }) =>
        await workspaceBackupService.getCheckpointDelta(opts.workingDirectory, opts.targetSessionId, opts.checkpointId),
      getLiveSessionSnapshotImpl: (sessionId: string) => sessionBindings.get(sessionId)?.session?.buildSessionSnapshot() ?? null,
      getLiveSessionWorkingDirectoryImpl: (sessionId: string) =>
        sessionBindings.get(sessionId)?.session?.getWorkingDirectory() ?? null,
      buildLegacySessionSnapshotImpl: (record: import("./sessionDb").PersistedSessionRecord) =>
        createLegacySessionSnapshot(record),
      getSkillMutationBlockReasonImpl: (workingDirectory: string) => {
        const busySession = [...sessionBindings.values()]
          .map((candidate) => candidate.session)
          .find((candidate): candidate is AgentSession =>
            !!candidate && candidate.getWorkingDirectory() === workingDirectory && candidate.isBusy
          );
        if (!busySession) {
          return null;
        }
        return "Skill mutations are blocked while another session in this workspace is running.";
      },
      refreshSkillsAcrossWorkspaceSessionsImpl: async (workingDirectory: string) => {
        const sessions = [...sessionBindings.values()]
          .map((candidate) => candidate.session)
          .filter((candidate): candidate is AgentSession =>
            !!candidate && candidate.getWorkingDirectory() === workingDirectory
          );
        await Promise.all(
          sessions.map(async (session) => {
            await session.refreshSystemPromptWithSkills("skills.workspace_refresh");
          }),
        );
      },
    };
  };

  const disposeBinding = (binding: SessionBinding, reason: string) => {
    if (!binding.session) return;
    try {
      binding.session.cancel();
    } catch {
      // ignore
    }
    try {
      binding.session.dispose(reason);
    } catch {
      // ignore
    }
    try {
      binding.socket?.close();
    } catch {
      // ignore
    }
  };

  const loadInitialSessionSnapshot = (persisted: PersistedSessionRecord) => {
    try {
      const snapshot = sessionDb.getSessionSnapshot(persisted.sessionId);
      if (!snapshot) {
        return createLegacySessionSnapshot(persisted);
      }
      if (snapshot.lastEventSeq < persisted.lastEventSeq) {
        return createLegacySessionSnapshot(persisted);
      }
      return snapshot;
    } catch {
      return createLegacySessionSnapshot(persisted);
    }
  };

  const buildSession = (
    binding: SessionBinding,
    persistedSessionId?: string,
    overrides?: {
      config?: AgentConfig;
      system?: string;
      seedContext?: SeededSessionContext;
      sessionInfoPatch?: Partial<SessionInfoState>;
    },
  ): {
    session: AgentSession;
    isResume: boolean;
    resumedFromStorage: boolean;
  } => {
    if (persistedSessionId) {
      const persisted = sessionDb.getSessionRecord(persistedSessionId);
      if (persisted) {
        const common = buildSessionCommon(binding, persisted.sessionKind);
        const session = AgentSession.fromPersisted({
          persisted,
          initialSessionSnapshot: loadInitialSessionSnapshot(persisted),
          baseConfig: { ...config },
          ...common,
        });
        return { session, isResume: true, resumedFromStorage: true };
      }
    }

    const sessionKind = overrides?.sessionInfoPatch?.sessionKind ?? "root";
    const common = buildSessionCommon(binding, sessionKind);
    const session = new AgentSession({
      config: { ...(overrides?.config ?? config) },
      system: overrides?.system ?? system,
      ...(overrides?.seedContext ? { seedContext: overrides.seedContext } : {}),
      ...(overrides?.sessionInfoPatch ? { sessionInfoPatch: overrides.sessionInfoPatch } : {}),
      ...common,
    });
    return { session, isResume: false, resumedFromStorage: false };
  };

  const getConnectedProviders = async (parentConfig: AgentConfig): Promise<AgentConfig["provider"][]> => (
    await getProviderCatalog({ homedir: resolveAuthHomeDir(parentConfig, opts.homedir) })
  ).connected as AgentConfig["provider"][];

  agentControl = new AgentControl({
    sessionBindings,
    sessionDb,
    getConnectedProviders,
    buildSession,
    loadAgentPrompt,
    disposeBinding,
    emitParentAgentStatus: (parentSessionId, agent) => {
      const parentBinding = sessionBindings.get(parentSessionId);
      const socket = parentBinding?.socket;
      if (!socket) return;
      try {
        socket.send(JSON.stringify({ type: "agent_status", sessionId: parentSessionId, agent }));
      } catch {
        // ignore
      }
    },
    emitParentLog: (parentSessionId, line) => {
      const parentBinding = sessionBindings.get(parentSessionId);
      const socket = parentBinding?.socket;
      if (!socket) return;
      try {
        socket.send(JSON.stringify({ type: "log", sessionId: parentSessionId, line }));
      } catch {
        // ignore
      }
    },
  });

  function createServer(port: number): ReturnType<typeof Bun.serve> {
    return Bun.serve<StartServerSocketData>({
      hostname,
      port,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const resumeSessionIdRaw = url.searchParams.get("resumeSessionId");
          const resumeSessionId = resumeSessionIdRaw && resumeSessionIdRaw.trim() ? resumeSessionIdRaw.trim() : undefined;
          const upgraded = srv.upgrade(req, { data: { resumeSessionId } });
          if (upgraded) return;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return new Response("OK", { status: 200 });
      },
      websocket: {
        open(ws) {
          const resumeSessionId = ws.data.resumeSessionId;
          const resumable =
            resumeSessionId && sessionBindings.has(resumeSessionId)
              ? sessionBindings.get(resumeSessionId)
              : undefined;
          const resumableSession = resumable?.session ?? null;

          let session: AgentSession;
          let binding: SessionBinding;
          let isResume = false;
          let resumedFromStorage = false;

          if (resumable && resumable.socket === null && resumableSession) {
            binding = resumable;
            binding.socket = ws;
            session = resumableSession;
            isResume = true;
          } else {
            binding = {
              session: null,
              socket: ws,
            };
            const built = buildSession(binding, resumeSessionId);
            session = built.session;
            isResume = built.isResume;
            resumedFromStorage = built.resumedFromStorage;
            binding.session = session;
            sessionBindings.set(session.id, binding);
          }

          ws.data.session = session;
          ws.data.resumeSessionId = session.id;

          const emitToCurrentSocket = (evt: ServerEvent) => {
            try {
              ws.send(JSON.stringify(evt));
            } catch {
              // ignore
            }
          };

          const sessionInfo = session.getSessionInfoEvent();
          const hello: ServerEvent = {
            type: "server_hello",
            sessionId: session.id,
            protocolVersion: WEBSOCKET_PROTOCOL_VERSION,
            capabilities: {
              modelStreamChunk: "v1",
            },
            config: session.getPublicConfig(),
            sessionKind: sessionInfo.sessionKind,
            ...(sessionInfo.parentSessionId ? { parentSessionId: sessionInfo.parentSessionId } : {}),
            ...(sessionInfo.role ? { role: sessionInfo.role } : {}),
            ...(sessionInfo.mode ? { mode: sessionInfo.mode } : {}),
            ...(typeof sessionInfo.depth === "number" ? { depth: sessionInfo.depth } : {}),
            ...(sessionInfo.nickname ? { nickname: sessionInfo.nickname } : {}),
            ...(sessionInfo.requestedModel ? { requestedModel: sessionInfo.requestedModel } : {}),
            ...(sessionInfo.effectiveModel ? { effectiveModel: sessionInfo.effectiveModel } : {}),
            ...(sessionInfo.requestedReasoningEffort
              ? { requestedReasoningEffort: sessionInfo.requestedReasoningEffort }
              : {}),
            ...(sessionInfo.effectiveReasoningEffort
              ? { effectiveReasoningEffort: sessionInfo.effectiveReasoningEffort }
              : {}),
            ...(sessionInfo.executionState ? { executionState: sessionInfo.executionState } : {}),
            ...(sessionInfo.lastMessagePreview ? { lastMessagePreview: sessionInfo.lastMessagePreview } : {}),
            ...(isResume
              ? {
                  isResume: true,
                  ...(resumedFromStorage ? { resumedFromStorage: true } : {}),
                  busy: session.isBusy,
                  ...(session.isBusy && session.activeTurnId ? { turnId: session.activeTurnId } : {}),
                  messageCount: session.messageCount,
                  hasPendingAsk: session.hasPendingAsk,
                  hasPendingApproval: session.hasPendingApproval,
                }
              : {}),
            ...(sessionInfo.sessionKind !== "root"
              ? {
                  sessionKind: sessionInfo.sessionKind,
                  ...(sessionInfo.parentSessionId ? { parentSessionId: sessionInfo.parentSessionId } : {}),
                  ...(sessionInfo.role ? { role: sessionInfo.role } : {}),
                  ...(sessionInfo.mode ? { mode: sessionInfo.mode } : {}),
                  ...(typeof sessionInfo.depth === "number" ? { depth: sessionInfo.depth } : {}),
                  ...(sessionInfo.nickname ? { nickname: sessionInfo.nickname } : {}),
                  ...(sessionInfo.requestedModel ? { requestedModel: sessionInfo.requestedModel } : {}),
                  ...(sessionInfo.effectiveModel ? { effectiveModel: sessionInfo.effectiveModel } : {}),
                  ...(sessionInfo.requestedReasoningEffort
                    ? { requestedReasoningEffort: sessionInfo.requestedReasoningEffort }
                    : {}),
                  ...(sessionInfo.effectiveReasoningEffort
                    ? { effectiveReasoningEffort: sessionInfo.effectiveReasoningEffort }
                    : {}),
                  ...(sessionInfo.executionState ? { executionState: sessionInfo.executionState } : {}),
                  ...(sessionInfo.lastMessagePreview ? { lastMessagePreview: sessionInfo.lastMessagePreview } : {}),
                }
              : {}),
          };

          ws.send(JSON.stringify(hello));

          const settings: ServerEvent = {
            type: "session_settings",
            sessionId: session.id,
            enableMcp: session.getEnableMcp(),
            enableMemory: session.getEnableMemory(),
            memoryRequireApproval: session.getMemoryRequireApproval(),
          };
          ws.send(JSON.stringify(settings));
          ws.send(JSON.stringify(session.getSessionConfigEvent()));
          ws.send(JSON.stringify(session.getSessionInfoEvent()));

          ws.send(JSON.stringify(session.getObservabilityStatusEvent()));
          void session.emitProviderCatalog();
          session.emitProviderAuthMethods();
          void session.refreshProviderStatus();
          void session.emitMcpServers();
          // Feature 7: push backup state on connect
          void session.getSessionBackupState();
          if (isResume) {
            for (const evt of session.drainDisconnectedReplayEvents()) {
              emitToCurrentSocket(evt);
            }
          }
          // Feature 1: replay pending prompts on reconnect
          if (isResume) {
            session.replayPendingPrompts();
          }
        },
        message(ws, raw) {
          const session = ws.data.session;
          if (!session) return;

          const decoded = decodeClientMessage(raw, session.id);
          if (!decoded.ok) {
            ws.send(JSON.stringify(decoded.event));
            return;
          }

          dispatchClientMessage({
            ws,
            session,
            message: decoded.message,
            sessionBindings,
          });
        },
        close(ws) {
          const session = ws.data.session;
          if (!session) return;
          const binding = sessionBindings.get(session.id);
          if (!binding) return;

          if (binding.socket === ws) {
            binding.socket = null;
            session.beginDisconnectedReplayBuffer();
          }
        },
      },
    });
  }

  function isAddrInUse(err: unknown): boolean {
    const parsed = errorWithCodeSchema.safeParse(err);
    return parsed.success && parsed.data.code === "EADDRINUSE";
  }

  const requestedPort = opts.port ?? 7337;

  function serveWithPortFallback(port: number): ReturnType<typeof Bun.serve> {
    try {
      // Normal behavior: when port=0, Bun (like Node) will request an ephemeral port from the OS.
      return createServer(port);
    } catch (err) {
      // Fallback for environments/versions where binding port 0 may fail.
      if (port !== 0) throw err;

      const min = 49152;
      const max = 65535;
      const attempts = 50;
      let lastErr: unknown = err;

      for (let i = 0; i < attempts; i++) {
        const candidate = min + Math.floor(Math.random() * (max - min + 1));
        try {
          return createServer(candidate);
        } catch (e) {
          lastErr = e;
          if (isAddrInUse(e)) continue;
          throw e;
        }
      }

      throw lastErr;
    }
  }

  const server = serveWithPortFallback(requestedPort);
  const originalStop = server.stop.bind(server) as (closeActiveConnections?: boolean) => Promise<void>;
  let serverStopped = false;
  const stoppableServer = server as typeof server & { stop: (closeActiveConnections?: boolean) => Promise<void> };
  stoppableServer.stop = async (closeActiveConnections?: boolean) => {
    if (serverStopped) return;
    serverStopped = true;
    // Dispose all active sessions to abort running turns and close MCP child processes.
    const persistenceFlushes: Promise<void>[] = [];
    for (const [id, binding] of sessionBindings) {
      if (!binding.session) {
        sessionBindings.delete(id);
        continue;
      }
      try {
        binding.session.dispose("server stopping");
      } catch {
        // ignore
      }
      try {
        persistenceFlushes.push(binding.session.waitForPersistenceIdle());
      } catch {
        // ignore
      }
      try {
        binding.socket?.close();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.allSettled(persistenceFlushes);
    sessionBindings.clear();
    try {
      sessionDb.close();
    } catch {
      // ignore
    }
    await originalStop(closeActiveConnections);
  };

  const url = `ws://${hostname}:${server.port}/ws`;
  return { server: stoppableServer, config, system, url };
}
