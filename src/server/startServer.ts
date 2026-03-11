import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getAiCoworkerPaths as getAiCoworkerPathsDefault } from "../connect";
import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../connect";
import type { runTurn as runTurnFn } from "../agent";
import type { AgentConfig } from "../types";
import { loadConfig } from "../config";
import { loadSubAgentPrompt, loadSystemPromptWithSkills } from "../prompt";
import type { OpenAiCompatibleProviderOptionsByProvider } from "../shared/openaiCompatibleOptions";
import type { PersistentSubagentSummary, SessionKind, SubagentAgentType } from "../shared/persistentSubagents";
import {
  OPENAI_COMPATIBLE_PROVIDER_NAMES,
  mergeEditableOpenAiCompatibleProviderOptions,
} from "../shared/openaiCompatibleOptions";
import { ensureDefaultGlobalSkillsReady } from "../skills/defaultGlobalSkills";
import { writeTextFileAtomic } from "../utils/atomicFile";

import { AgentSession } from "./session/AgentSession";
import { SessionDb } from "./sessionDb";
import { WorkspaceBackupService } from "./workspaceBackups";
import {
  WEBSOCKET_PROTOCOL_VERSION,
  type ServerEvent,
} from "./protocol";
import { decodeClientMessage } from "./startServer/decodeClientMessage";
import { dispatchClientMessage } from "./startServer/dispatchClientMessage";
import { type SessionBinding, type StartServerSocketData } from "./startServer/types";
import type { SessionInfoState } from "./session/SessionContext";

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
  patch: Partial<Pick<AgentConfig, "provider" | "model" | "subAgentModel" | "enableMcp" | "observabilityEnabled" | "backupsEnabled">> & {
    providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
  },
  runtimeProviderOptions?: AgentConfig["providerOptions"],
): Promise<void> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const configPath = path.join(projectAgentDir, "config.json");
  const current = await loadJsonObjectSafe(configPath);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of entries) {
    if (key === "providerOptions") {
      const currentProviderOptions = isPlainObject(current[key]) ? { ...current[key] } : {};
      for (const provider of OPENAI_COMPATIBLE_PROVIDER_NAMES) {
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
    next[key] = value;
  }
  await fs.mkdir(projectAgentDir, { recursive: true });
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  await writeTextFileAtomic(configPath, payload);
}

function mergeConfigPatch(
  config: AgentConfig,
  patch: Partial<Pick<AgentConfig, "provider" | "model" | "subAgentModel" | "enableMcp" | "observabilityEnabled" | "backupsEnabled">> & {
    providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
  }
): AgentConfig {
  const next: AgentConfig = { ...config, ...patch };
  if (patch.providerOptions !== undefined) {
    next.providerOptions = mergeEditableOpenAiCompatibleProviderOptions(config.providerOptions, patch.providerOptions);
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
    COWORK_DISABLE_BUILTIN_SKILLS: string;
    COWORK_BUILTIN_DIR?: string;
  } = {
    ...rawEnv,
    COWORK_DISABLE_BUILTIN_SKILLS: rawEnv.COWORK_DISABLE_BUILTIN_SKILLS ?? "1",
  };

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
            subAgentModel: string;
          }) => {
            await persistProjectConfigPatch(config.projectAgentDir, selection, config.providerOptions);
            config = mergeConfigPatch(config, selection);
          }
        : undefined,
      persistProjectConfigPatchImpl: sessionKind === "root"
        ? async (
            patch: Partial<Pick<AgentConfig, "provider" | "model" | "subAgentModel" | "enableMcp" | "observabilityEnabled" | "backupsEnabled">> & {
              providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
            }
          ) => {
            await persistProjectConfigPatch(config.projectAgentDir, patch, config.providerOptions);
            config = mergeConfigPatch(config, patch);
          }
        : undefined,
      sessionDb,
      emit,
      createSubagentSessionImpl: subagentOps.create,
      listSubagentSessionsImpl: subagentOps.list,
      sendSubagentInputImpl: subagentOps.sendInput,
      waitForSubagentImpl: subagentOps.wait,
      closeSubagentImpl: subagentOps.close,
      deleteSessionImpl: subagentOps.deleteSession,
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
    };
  };

  const buildSubagentSummary = (session: AgentSession, busy = session.isBusy): PersistentSubagentSummary => {
    if (session.sessionKind !== "subagent" || !session.parentSessionId || !session.agentType) {
      throw new Error(`Session ${session.id} is not a persistent subagent`);
    }
    const info = session.getSessionInfoEvent();
    return {
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      agentType: session.agentType,
      title: info.title,
      provider: info.provider,
      model: info.model,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      status: session.persistenceStatus,
      busy,
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

  const ensurePersistentSessionBinding = (sessionId: string): SessionBinding | null => {
    const existing = sessionBindings.get(sessionId);
    if (existing?.session) return existing;

    const persisted = sessionDb.getSessionRecord(sessionId);
    if (!persisted) return null;

    const binding: SessionBinding = { session: null, socket: null };
    const session = AgentSession.fromPersisted({
      persisted,
      baseConfig: { ...config },
      ...buildSessionCommon(binding, persisted.sessionKind),
    });
    binding.session = session;
    session.beginDisconnectedReplayBuffer();
    sessionBindings.set(session.id, binding);
    return binding;
  };

  const buildSession = (
    binding: SessionBinding,
    persistedSessionId?: string,
    overrides?: {
      config?: AgentConfig;
      system?: string;
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
      ...(overrides?.sessionInfoPatch ? { sessionInfoPatch: overrides.sessionInfoPatch } : {}),
      ...common,
    });
    return { session, isResume: false, resumedFromStorage: false };
  };

  const subagentOps = {
    create: async (opts: {
      parentSessionId: string;
      parentConfig: AgentConfig;
      agentType: SubagentAgentType;
      task: string;
    }): Promise<PersistentSubagentSummary> => {
      const childModel = opts.agentType === "research" ? opts.parentConfig.model : opts.parentConfig.subAgentModel;
      const childConfig: AgentConfig = {
        ...opts.parentConfig,
        model: childModel,
      };
      const childSystem = await loadSubAgentPrompt(opts.parentConfig, opts.agentType);
      const binding: SessionBinding = { session: null, socket: null };
      const built = buildSession(binding, undefined, {
        config: childConfig,
        system: childSystem,
        sessionInfoPatch: {
          sessionKind: "subagent",
          parentSessionId: opts.parentSessionId,
          agentType: opts.agentType,
        },
      });
      binding.session = built.session;
      built.session.beginDisconnectedReplayBuffer();
      sessionBindings.set(built.session.id, binding);
      void built.session.sendUserMessage(opts.task);
      return buildSubagentSummary(built.session);
    },
    list: async (parentSessionId: string): Promise<PersistentSubagentSummary[]> => {
      const summaries = new Map(
        sessionDb.listSubagentSessions(parentSessionId).map((summary) => [summary.sessionId, summary] as const),
      );
      for (const binding of sessionBindings.values()) {
        const session = binding.session;
        if (!session?.isSubagentOf(parentSessionId)) continue;
        summaries.set(session.id, buildSubagentSummary(session));
      }
      return [...summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    sendInput: async (opts: { parentSessionId: string; agentId: string; task: string }): Promise<void> => {
      const binding = ensurePersistentSessionBinding(opts.agentId);
      if (!binding?.session || !binding.session.isSubagentOf(opts.parentSessionId)) {
        throw new Error(`Unknown subagent session: ${opts.agentId}`);
      }
      if (binding.session.isBusy) {
        throw new Error(`Subagent ${opts.agentId} is busy`);
      }
      void binding.session.sendUserMessage(opts.task);
    },
    wait: async (opts: {
      parentSessionId: string;
      agentId: string;
      timeoutMs?: number;
    }): Promise<{ sessionId: string; status: "completed" | "running" | "error" | "closed"; busy: boolean; text?: string }> => {
      const binding = ensurePersistentSessionBinding(opts.agentId);
      if (!binding?.session || !binding.session.isSubagentOf(opts.parentSessionId)) {
        throw new Error(`Unknown subagent session: ${opts.agentId}`);
      }

      const timeoutMs = opts.timeoutMs ?? 30_000;
      const startedAt = Date.now();
      while (binding.session.isBusy && Date.now() - startedAt < timeoutMs) {
        await Bun.sleep(50);
      }

      const busy = binding.session.isBusy;
      const status = busy
        ? "running"
        : binding.session.persistenceStatus === "closed"
          ? "closed"
          : binding.session.currentTurnOutcome === "error"
            ? "error"
            : "completed";

      return {
        sessionId: binding.session.id,
        status,
        busy,
        ...(binding.session.getLatestAssistantText() ? { text: binding.session.getLatestAssistantText() } : {}),
      };
    },
    close: async (opts: { parentSessionId: string; agentId: string }): Promise<PersistentSubagentSummary> => {
      const binding = ensurePersistentSessionBinding(opts.agentId);
      if (!binding?.session || !binding.session.isSubagentOf(opts.parentSessionId)) {
        throw new Error(`Unknown subagent session: ${opts.agentId}`);
      }
      binding.session.cancel();
      await binding.session.closeForHistory();
      disposeBinding(binding, "parent closed subagent");
      sessionBindings.delete(binding.session.id);
      return {
        ...buildSubagentSummary(binding.session, false),
        status: "closed",
        busy: false,
      };
    },
    deleteSession: async (opts: { requesterSessionId: string; targetSessionId: string }): Promise<void> => {
      void opts.requesterSessionId;
      const liveChildIds = [...sessionBindings.values()]
        .map((binding) => binding.session)
        .filter((session): session is AgentSession => !!session && session.isSubagentOf(opts.targetSessionId))
        .map((session) => session.id);
      const persistedChildIds = sessionDb.listSubagentSessions(opts.targetSessionId).map((summary) => summary.sessionId);
      const sessionIdsToDispose = new Set([opts.targetSessionId, ...persistedChildIds, ...liveChildIds]);

      for (const sessionId of sessionIdsToDispose) {
        const binding = sessionBindings.get(sessionId);
        if (!binding?.session) continue;
        disposeBinding(binding, `session ${opts.targetSessionId} deleted`);
        sessionBindings.delete(sessionId);
      }

      sessionDb.deleteSession(opts.targetSessionId);
    },
  };

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

          const hello: ServerEvent = {
            type: "server_hello",
            sessionId: session.id,
            protocolVersion: WEBSOCKET_PROTOCOL_VERSION,
            capabilities: {
              modelStreamChunk: "v1",
            },
            config: session.getPublicConfig(),
            sessionKind: session.sessionKind,
            ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
            ...(session.agentType ? { agentType: session.agentType } : {}),
            ...(isResume
              ? {
                  isResume: true,
                  ...(resumedFromStorage ? { resumedFromStorage: true } : {}),
                  busy: session.isBusy,
                  messageCount: session.messageCount,
                  hasPendingAsk: session.hasPendingAsk,
                  hasPendingApproval: session.hasPendingApproval,
                }
              : {}),
            ...(session.sessionKind !== "root"
              ? {
                  sessionKind: session.sessionKind,
                  ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
                  ...(session.agentType ? { agentType: session.agentType } : {}),
                }
              : {}),
          };

          ws.send(JSON.stringify(hello));

          const settings: ServerEvent = {
            type: "session_settings",
            sessionId: session.id,
            enableMcp: session.getEnableMcp(),
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
        binding.socket?.close();
      } catch {
        // ignore
      }
    }
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
