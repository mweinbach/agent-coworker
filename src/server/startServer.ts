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
import { SessionDb, type PersistedSessionRecord, type PersistedThreadJournalEvent } from "./sessionDb";
import { WorkspaceBackupService } from "./workspaceBackups";
import {
  WEBSOCKET_PROTOCOL_VERSION,
  type ServerEvent,
} from "./protocol";
import { decodeJsonRpcMessage } from "./jsonrpc/decodeJsonRpcMessage";
import { dispatchJsonRpcMessage } from "./jsonrpc/dispatchJsonRpcMessage";
import { createThreadJournalProjector } from "./jsonrpc/journalProjector";
import { createJsonRpcLegacyEventProjector } from "./jsonrpc/legacyEventProjector";
import {
  buildJsonRpcErrorResponse,
  buildJsonRpcResultResponse,
  JSONRPC_ERROR_CODES,
} from "./jsonrpc/protocol";
import { createJsonRpcRequestRouter } from "./jsonrpc/routes";
import {
  buildControlSessionStateEvents,
  buildJsonRpcThreadFromRecord,
  buildJsonRpcThreadFromSession,
  extractJsonRpcTextInput,
  isJsonRpcSessionError,
  requireWorkspacePath,
  shouldIncludeJsonRpcThreadSummary,
} from "./jsonrpc/routes/shared";
import { decodeClientMessage } from "./startServer/decodeClientMessage";
import { dispatchClientMessage } from "./startServer/dispatchClientMessage";
import { type SessionBinding, type StartServerSocketData } from "./startServer/types";
import type { SeededSessionContext, SessionDependencies, SessionInfoState } from "./session/SessionContext";
import {
  parseWsProtocolDefault,
  resolveWsProtocol,
  splitWebSocketSubprotocolHeader,
  type WsProtocolMode,
} from "./wsProtocol/negotiation";
import {
  enqueueThreadJournalWrite,
  waitForThreadJournalWriteQueueIdle,
} from "./startServer/threadJournalWriteQueue";

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
  wsProtocolDefault?: WsProtocolMode;
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
  const wsProtocolDefault = opts.wsProtocolDefault ?? parseWsProtocolDefault(env.COWORK_WS_DEFAULT_PROTOCOL);
  const parsedJsonRpcMaxPendingRequests = Number(env.COWORK_WS_JSONRPC_MAX_PENDING_REQUESTS ?? "128");
  const jsonRpcMaxPendingRequests = Math.max(
    0,
    Number.isFinite(parsedJsonRpcMaxPendingRequests)
      ? Math.floor(parsedJsonRpcMaxPendingRequests)
      : 128,
  );

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
  const workspaceControlBindings = new Map<string, SessionBinding>();
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

  const addBindingSink = (binding: SessionBinding, sinkId: string, sink: (evt: ServerEvent) => void) => {
    binding.sinks.set(sinkId, sink);
  };

  const removeBindingSink = (binding: SessionBinding, sinkId: string) => {
    binding.sinks.delete(sinkId);
  };

  const countLiveConnectionSinks = (binding: SessionBinding) => (
    [...binding.sinks.keys()].filter((sinkId) => !sinkId.startsWith("journal:")).length
  );

  const getOrCreateWorkspaceControlBinding = (cwd: string): SessionBinding => {
    const existing = workspaceControlBindings.get(cwd);
    if (existing?.session) {
      return existing;
    }
    const binding: SessionBinding = {
      session: null,
      socket: null,
      sinks: new Map(),
    };
    const controlConfig: AgentConfig = {
      ...config,
      workingDirectory: cwd,
    };
    const built = buildSession(binding, undefined, {
      config: controlConfig,
    });
    binding.session = built.session;
    workspaceControlBindings.set(cwd, binding);
    return binding;
  };

  const captureSessionEvent = async <T extends ServerEvent>(
    binding: SessionBinding,
    action: () => Promise<void> | void,
    predicate: (event: ServerEvent) => event is T,
    timeoutMs = 5_000,
  ): Promise<T> => {
    const sinkId = `capture:${crypto.randomUUID()}`;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        removeBindingSink(binding, sinkId);
        reject(new Error("Timed out waiting for control event"));
      }, timeoutMs);

      addBindingSink(binding, sinkId, (event) => {
        if (!predicate(event)) return;
        clearTimeout(timeout);
        removeBindingSink(binding, sinkId);
        resolve(event);
      });

      void Promise.resolve(action()).catch((error) => {
        clearTimeout(timeout);
        removeBindingSink(binding, sinkId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  const captureSessionMutationOutcome = async <T extends ServerEvent>(
    binding: SessionBinding,
    action: () => Promise<void> | void,
    predicate: (event: ServerEvent) => event is T,
    timeoutMs = 5_000,
    idleMs = 25,
  ): Promise<T | null> => {
    const sinkId = `capture:${crypto.randomUUID()}`;
    return await new Promise<T | null>((resolve, reject) => {
      let actionResolved = false;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (value: T | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        removeBindingSink(binding, sinkId);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        removeBindingSink(binding, sinkId);
        reject(new Error("Timed out waiting for control event"));
      }, timeoutMs);

      addBindingSink(binding, sinkId, (event) => {
        if (!predicate(event)) return;
        settle(event);
      });

      void Promise.resolve(action())
        .then(() => {
          actionResolved = true;
          idleTimer = setTimeout(() => {
            if (actionResolved) {
              settle(null);
            }
          }, idleMs);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (idleTimer) {
            clearTimeout(idleTimer);
          }
          removeBindingSink(binding, sinkId);
          reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  const buildSessionCommon = (binding: SessionBinding, sessionKind: SessionKind = "root") => {
    const emit = (evt: ServerEvent) => {
      for (const sink of binding.sinks.values()) {
        try {
          sink(evt);
        } catch {
          // ignore individual sink failures
        }
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
      if (!parentBinding) return;
      for (const sink of parentBinding.sinks.values()) {
        try {
          sink({ type: "agent_status", sessionId: parentSessionId, agent });
        } catch {
          // ignore
        }
      }
    },
    emitParentLog: (parentSessionId, line) => {
      const parentBinding = sessionBindings.get(parentSessionId);
      if (!parentBinding) return;
      for (const sink of parentBinding.sinks.values()) {
        try {
          sink({ type: "log", sessionId: parentSessionId, line });
        } catch {
          // ignore
        }
      }
    },
  });

  const openJsonRpcSocket = (ws: Bun.ServerWebSocket<StartServerSocketData>) => {
    ws.data.rpc = {
      initializeRequestReceived: false,
      initializedNotificationReceived: false,
      pendingRequestCount: 0,
      maxPendingRequests: jsonRpcMaxPendingRequests,
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [],
      },
      pendingServerRequests: new Map(),
    };
  };

  const openLegacySocket = (ws: Bun.ServerWebSocket<StartServerSocketData>) => {
    const resumeSessionId = ws.data.resumeSessionId;
    const legacySinkId = `legacy:${ws.data.connectionId ?? "unknown"}`;
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
        sinks: new Map(),
      };
      const built = buildSession(binding, resumeSessionId);
      session = built.session;
      isResume = built.isResume;
      resumedFromStorage = built.resumedFromStorage;
      binding.session = session;
      ensureThreadJournalSink(binding, session.id);
      sessionBindings.set(session.id, binding);
    }

    ws.data.session = session;
    ws.data.resumeSessionId = session.id;
    ensureThreadJournalSink(binding, session.id);
    addBindingSink(binding, legacySinkId, (evt) => {
      try {
        ws.send(JSON.stringify(evt));
      } catch {
        // ignore
      }
    });

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
    void session.getSessionBackupState();
    if (isResume) {
      for (const evt of session.drainDisconnectedReplayEvents()) {
        try {
          ws.send(JSON.stringify(evt));
        } catch {
          // ignore
        }
      }
    }
    if (isResume) {
      session.replayPendingPrompts();
    }
  };

  const closeLegacySocket = (ws: Bun.ServerWebSocket<StartServerSocketData>) => {
    const session = ws.data.session;
    if (!session) return;
    const binding = sessionBindings.get(session.id);
    if (!binding) return;
    removeBindingSink(binding, `legacy:${ws.data.connectionId ?? "unknown"}`);

    if (binding.socket === ws) {
      binding.socket = null;
    }
    if (countLiveConnectionSinks(binding) === 0) {
      session.beginDisconnectedReplayBuffer();
    }
  };

  const jsonRpcSubscriptionsByConnectionId = new Map<string, Map<string, { sinkId: string }>>();
  const threadJournalWriteQueues = new Map<string, Promise<void>>();
  const threadJournalPendingBatches = new Map<string, {
    events: Array<Omit<PersistedThreadJournalEvent, "seq">>;
    started: boolean;
    promise: Promise<void>;
  }>();
  const threadJournalReplayBatchSize = 250;

  const sendJsonRpc = (ws: Bun.ServerWebSocket<StartServerSocketData>, payload: unknown) => {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  };

  const shouldSendJsonRpcNotification = (ws: Bun.ServerWebSocket<StartServerSocketData>, method: string) => (
    !ws.data.rpc?.capabilities.optOutNotificationMethods.includes(method)
  );

  const enqueueThreadJournalEvent = (event: Omit<PersistedThreadJournalEvent, "seq">) => {
    const openBatch = threadJournalPendingBatches.get(event.threadId);
    if (openBatch && !openBatch.started) {
      openBatch.events.push(event);
      return openBatch.promise;
    }

    const batch = {
      events: [event],
      started: false,
      promise: Promise.resolve(),
    };
    const writePromise = enqueueThreadJournalWrite(threadJournalWriteQueues, event.threadId, async () => {
      batch.started = true;
      if (threadJournalPendingBatches.get(event.threadId) === batch) {
        threadJournalPendingBatches.delete(event.threadId);
      }
      await sessionDb.appendThreadJournalEvents(batch.events);
    });

    batch.promise = writePromise;
    threadJournalPendingBatches.set(event.threadId, batch);
    return writePromise;
  };

  const waitForThreadJournalIdle = async (threadId: string) => {
    await waitForThreadJournalWriteQueueIdle(threadJournalWriteQueues, threadId);
  };

  const ensureJsonRpcConnectionSubscriptions = (connectionId: string) => {
    const existing = jsonRpcSubscriptionsByConnectionId.get(connectionId);
    if (existing) return existing;
    const created = new Map<string, { sinkId: string }>();
    jsonRpcSubscriptionsByConnectionId.set(connectionId, created);
    return created;
  };

  const ensureThreadJournalSink = (binding: SessionBinding, threadId: string) => {
    const sinkId = `journal:${threadId}`;
    if (binding.sinks.has(sinkId)) {
      return;
    }
    const projector = createThreadJournalProjector({
      threadId,
      emit: (event) => {
        void enqueueThreadJournalEvent(event).catch(() => {
          // Best-effort journal persistence; session state snapshots remain authoritative fallback state.
        });
      },
    });
    addBindingSink(binding, sinkId, (event) => projector.handle(event));
  };

  const loadThreadBinding = (threadId: string): SessionBinding | null => {
    const existing = sessionBindings.get(threadId);
    if (existing?.session) {
      ensureThreadJournalSink(existing, threadId);
      return existing;
    }
    const persisted = sessionDb.getSessionRecord(threadId);
    if (!persisted) return null;
    const binding: SessionBinding = { session: null, socket: null, sinks: new Map() };
    const built = buildSession(binding, threadId);
    binding.session = built.session;
    ensureThreadJournalSink(binding, built.session.id);
    sessionBindings.set(built.session.id, binding);
    return binding;
  };

  const subscribeJsonRpcThread = (
    ws: Bun.ServerWebSocket<StartServerSocketData>,
    threadId: string,
    opts?: {
      initialActiveTurnId?: string | null;
      initialAgentText?: string | null;
      drainDisconnectedReplayBuffer?: boolean;
    },
  ): SessionBinding | null => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) {
      return null;
    }

    const binding = loadThreadBinding(threadId);
    if (!binding?.session) {
      return null;
    }

    const subscriptions = ensureJsonRpcConnectionSubscriptions(connectionId);
    if (subscriptions.has(threadId)) {
      return binding;
    }

    const shouldReplayBufferedEvents =
      opts?.drainDisconnectedReplayBuffer || (!binding.socket && countLiveConnectionSinks(binding) === 0);
    const sinkId = `jsonrpc:${connectionId}:${threadId}`;
    const projector = createJsonRpcLegacyEventProjector({
      threadId,
      send: (message) => sendJsonRpc(ws, message),
      shouldSendNotification: (method) => shouldSendJsonRpcNotification(ws, method),
      ...(opts?.initialActiveTurnId
        ? {
            initialActiveTurnId: opts.initialActiveTurnId,
            initialAgentText: opts.initialAgentText ?? "",
          }
        : {}),
      onServerRequest: (request) => {
        ws.data.rpc?.pendingServerRequests.set(request.id, {
          threadId: request.threadId,
          type: request.type,
          requestId: request.id,
        });
        sendJsonRpc(ws, {
          id: request.id,
          method: request.method,
          params: request.params,
        });
      },
    });

    addBindingSink(binding, sinkId, (event) => projector.handle(event));
    subscriptions.set(threadId, { sinkId });
    if (shouldReplayBufferedEvents) {
      for (const event of binding.session.drainDisconnectedReplayEvents()) {
        projector.handle(event);
      }
    }
    return binding;
  };

  const unsubscribeJsonRpcThread = (ws: Bun.ServerWebSocket<StartServerSocketData>, threadId: string) => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) {
      return "notSubscribed" as const;
    }
    const subscriptions = jsonRpcSubscriptionsByConnectionId.get(connectionId);
    const subscription = subscriptions?.get(threadId);
    if (!subscription) {
      const existingBinding = sessionBindings.get(threadId);
      return existingBinding?.session ? "notSubscribed" as const : "notLoaded" as const;
    }

    const binding = sessionBindings.get(threadId);
    if (binding) {
      removeBindingSink(binding, subscription.sinkId);
      if (!binding.socket && countLiveConnectionSinks(binding) === 0 && binding.session) {
        binding.session.beginDisconnectedReplayBuffer();
      }
    }
    subscriptions?.delete(threadId);
    if (subscriptions && subscriptions.size === 0) {
      jsonRpcSubscriptionsByConnectionId.delete(connectionId);
    }
    return "unsubscribed" as const;
  };

  const cleanupJsonRpcConnection = (ws: Bun.ServerWebSocket<StartServerSocketData>) => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) {
      return;
    }
    const subscriptions = jsonRpcSubscriptionsByConnectionId.get(connectionId);
    if (!subscriptions) {
      return;
    }
    for (const [threadId, subscription] of subscriptions) {
      const binding = sessionBindings.get(threadId);
      if (!binding) continue;
      removeBindingSink(binding, subscription.sinkId);
      if (!binding.socket && countLiveConnectionSinks(binding) === 0 && binding.session) {
        binding.session.beginDisconnectedReplayBuffer();
      }
    }
    jsonRpcSubscriptionsByConnectionId.delete(connectionId);
  };

  const readThreadSnapshot = (threadId: string) => {
    const liveSnapshot = sessionBindings.get(threadId)?.session?.buildSessionSnapshot() ?? null;
    if (liveSnapshot) return liveSnapshot;
    const persisted = sessionDb.getSessionRecord(threadId);
    if (!persisted) return null;
    return loadInitialSessionSnapshot(persisted);
  };

  const replayThreadJournalEvents = (
    ws: Bun.ServerWebSocket<StartServerSocketData>,
    threadId: string,
    afterSeq = 0,
    limit?: number,
  ) => {
    let cursor = Math.max(0, Math.floor(afterSeq));
    let remaining = typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : null;

    while (remaining === null || remaining > 0) {
      const batchLimit = remaining === null
        ? threadJournalReplayBatchSize
        : Math.min(threadJournalReplayBatchSize, remaining);
      const journalEvents = sessionDb.listThreadJournalEvents(threadId, {
        afterSeq: cursor,
        limit: batchLimit,
      });
      if (journalEvents.length === 0) {
        return;
      }

      for (const event of journalEvents) {
        if (event.eventType.startsWith("request:")) {
          const method = event.eventType.slice("request:".length);
          if (event.requestId) {
            ws.data.rpc?.pendingServerRequests.set(event.requestId, {
              threadId,
              type: method === "item/commandExecution/requestApproval" ? "approval" : "ask",
              requestId: event.requestId,
            });
          }
          sendJsonRpc(ws, {
            id: event.requestId ?? `${threadId}:${event.seq}`,
            method,
            params: event.payload,
          });
          continue;
        }
        if (!shouldSendJsonRpcNotification(ws, event.eventType)) {
          continue;
        }
        sendJsonRpc(ws, {
          method: event.eventType,
          params: event.payload,
        });
      }

      cursor = journalEvents.at(-1)?.seq ?? cursor;
      if (remaining !== null) {
        remaining -= journalEvents.length;
      }
      if (journalEvents.length < batchLimit) {
        return;
      }
    }
  };

  const withWorkspaceControlSession = async <T>(
    cwd: string,
    runner: (binding: SessionBinding, session: AgentSession) => Promise<T>,
  ): Promise<T> => {
    const binding = getOrCreateWorkspaceControlBinding(cwd);
    if (!binding.session) {
      throw new Error(`Unable to create workspace control session for ${cwd}`);
    }
    return await runner(binding, binding.session);
  };

  const routeJsonRpcResponse = (
    ws: Bun.ServerWebSocket<StartServerSocketData>,
    message: { id: string | number; result?: unknown; error?: { code: number; message: string } },
  ) => {
    const pending = ws.data.rpc?.pendingServerRequests.get(message.id);
    if (!pending) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: `Unknown server request id: ${String(message.id)}`,
      }));
      return;
    }

    const binding = sessionBindings.get(pending.threadId);
    const session = binding?.session;
    if (!session) {
      ws.data.rpc?.pendingServerRequests.delete(message.id);
      sendJsonRpc(ws, {
        method: "serverRequest/resolved",
        params: {
          threadId: pending.threadId,
          requestId: pending.requestId,
        },
      });
      return;
    }

    sendJsonRpc(ws, {
      method: "serverRequest/resolved",
      params: {
        threadId: pending.threadId,
        requestId: pending.requestId,
      },
    });

    if (pending.type === "approval") {
      const result = message.result as Record<string, unknown> | undefined;
      const decision = typeof result?.decision === "string" ? result.decision : undefined;
      const approved =
        result?.approved === true
        || decision === "accept"
        || decision === "acceptForSession";
      session.handleApprovalResponse(pending.requestId, approved);
    } else {
      const result = message.result as Record<string, unknown> | undefined;
      const answer =
        typeof result?.answer === "string"
          ? result.answer
          : Array.isArray(result?.content)
            ? extractJsonRpcTextInput(result.content)
            : "";
      session.handleAskResponse(pending.requestId, answer);
    }

    ws.data.rpc?.pendingServerRequests.delete(message.id);
    void enqueueThreadJournalEvent({
      threadId: pending.threadId,
      ts: new Date().toISOString(),
      eventType: "serverRequest/resolved",
      turnId: session.activeTurnId ?? null,
      itemId: null,
      requestId: pending.requestId,
      payload: {
        threadId: pending.threadId,
        requestId: pending.requestId,
      },
    }).catch(() => {
      // Best-effort journal persistence.
    });
  };

  const handleJsonRpcRequest = createJsonRpcRequestRouter({
    getConfig: () => config,
    threads: {
      create: ({ cwd, provider, model }) => {
        const binding: SessionBinding = { session: null, socket: null, sinks: new Map() };
        const threadConfig: AgentConfig = {
          ...config,
          workingDirectory: cwd,
          ...(provider ? { provider, runtime: defaultRuntimeNameForProvider(provider) } : {}),
          ...(model ? { model } : {}),
        };
        const built = buildSession(binding, undefined, {
          config: threadConfig,
        });
        binding.session = built.session;
        ensureThreadJournalSink(binding, built.session.id);
        sessionBindings.set(built.session.id, binding);
        return built.session;
      },
      load: loadThreadBinding,
      getLive: (threadId) => sessionBindings.get(threadId),
      getPersisted: (threadId) => sessionDb.getSessionRecord(threadId),
      listPersisted: (opts) => sessionDb.listSessions({ ...(opts?.cwd ? { workingDirectory: opts.cwd } : {}) })
        .flatMap((record) => {
          const persisted = sessionDb.getSessionRecord(record.sessionId);
          return persisted ? [persisted] : [];
        }),
      listLiveRoot: (opts) => [...sessionBindings.values()]
        .flatMap((binding) => {
          const session = binding.session;
          if (!session || session.sessionKind !== "root") return [];
          if (opts?.cwd && session.getWorkingDirectory() !== opts.cwd) return [];
          return [session];
        }),
      subscribe: subscribeJsonRpcThread,
      unsubscribe: unsubscribeJsonRpcThread,
      readSnapshot: readThreadSnapshot,
    },
    workspaceControl: {
      getOrCreateBinding: getOrCreateWorkspaceControlBinding,
      withSession: withWorkspaceControlSession,
    },
    journal: {
      enqueue: enqueueThreadJournalEvent,
      waitForIdle: waitForThreadJournalIdle,
      list: (threadId, opts) => sessionDb.listThreadJournalEvents(threadId, opts),
      replay: replayThreadJournalEvents,
    },
    events: {
      capture: captureSessionEvent,
      captureMutationOutcome: captureSessionMutationOutcome,
    },
    jsonrpc: {
      send: sendJsonRpc,
      sendResult: (ws, id, result) => {
        sendJsonRpc(ws, buildJsonRpcResultResponse(id, result));
      },
      sendError: (ws, id, error) => {
        sendJsonRpc(ws, buildJsonRpcErrorResponse(id, error));
      },
    },
    utils: {
      requireWorkspacePath,
      extractTextInput: extractJsonRpcTextInput,
      buildThreadFromSession: buildJsonRpcThreadFromSession,
      buildThreadFromRecord: buildJsonRpcThreadFromRecord,
      shouldIncludeThreadSummary: shouldIncludeJsonRpcThreadSummary,
      buildControlSessionStateEvents,
      isSessionError: isJsonRpcSessionError,
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
          const offeredSubprotocols = splitWebSocketSubprotocolHeader(req.headers.get("sec-websocket-protocol"));
          const protocolResult = resolveWsProtocol({
            offeredSubprotocols,
            requestedProtocol: url.searchParams.get("protocol"),
            defaultProtocol: wsProtocolDefault,
          });
          if (!protocolResult.ok) {
            return new Response(protocolResult.error, { status: 400 });
          }
          // Bun reliably auto-echoes the first offered subprotocol during upgrade, but manually
          // setting the response header can break single-offer connections on current releases.
          const selectedSubprotocolHeader = (
            protocolResult.protocol.selectedSubprotocol
            && offeredSubprotocols[0] !== protocolResult.protocol.selectedSubprotocol
          )
            ? protocolResult.protocol.selectedSubprotocol
            : undefined;
          const upgraded = srv.upgrade(req, {
            headers: selectedSubprotocolHeader
              ? {
                  "Sec-WebSocket-Protocol": selectedSubprotocolHeader,
                }
              : undefined,
            data: {
              resumeSessionId,
              protocolMode: protocolResult.protocol.mode,
              selectedSubprotocol: protocolResult.protocol.selectedSubprotocol,
              connectionId: crypto.randomUUID(),
            },
          });
          if (upgraded) return;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return new Response("OK", { status: 200 });
      },
      websocket: {
        open(ws) {
          if (ws.data.protocolMode === "jsonrpc") {
            openJsonRpcSocket(ws);
            return;
          }
          openLegacySocket(ws);
        },
        message(ws, raw) {
          if (ws.data.protocolMode === "jsonrpc") {
            const decoded = decodeJsonRpcMessage(raw);
            if (!decoded.ok) {
              ws.send(JSON.stringify(decoded.response));
              return;
            }
            const rpcState = ws.data.rpc;
            if (
              rpcState
              && "id" in decoded.message
              && "method" in decoded.message
              && decoded.message.method !== "initialize"
              && decoded.message.method !== "initialized"
              && rpcState.pendingRequestCount >= rpcState.maxPendingRequests
            ) {
              ws.send(JSON.stringify(buildJsonRpcErrorResponse(decoded.message.id, {
                code: JSONRPC_ERROR_CODES.serverOverloaded,
                message: "Server overloaded; retry later.",
              })));
              return;
            }
            dispatchJsonRpcMessage({
              ws,
              message: decoded.message,
              onRequest: (message) => {
                if (ws.data.rpc) {
                  ws.data.rpc.pendingRequestCount += 1;
                }
                void Promise.resolve(handleJsonRpcRequest(ws, message))
                  .catch((reason: unknown) => {
                    const id = "id" in message ? message.id : undefined;
                    if (id === undefined || id === null) {
                      return;
                    }
                    const detail = reason instanceof Error
                      ? reason.message
                      : typeof reason === "string"
                        ? reason
                        : "Internal error";
                    sendJsonRpc(ws, buildJsonRpcErrorResponse(id, {
                      code: JSONRPC_ERROR_CODES.internalError,
                      message: detail,
                    }));
                  })
                  .finally(() => {
                    if (ws.data.rpc) {
                      ws.data.rpc.pendingRequestCount = Math.max(0, ws.data.rpc.pendingRequestCount - 1);
                    }
                  });
              },
              onResponse: (message) => {
                routeJsonRpcResponse(ws, message);
              },
            });
            return;
          }

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
          if (ws.data.protocolMode === "jsonrpc") {
            cleanupJsonRpcConnection(ws);
            return;
          }
          closeLegacySocket(ws);
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
