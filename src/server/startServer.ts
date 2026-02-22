import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getAiCoworkerPaths as getAiCoworkerPathsDefault } from "../connect";
import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../connect";
import type { runTurn as runTurnFn } from "../agent";
import type { AgentConfig } from "../types";
import type { ServerErrorCode } from "../types";
import { loadConfig } from "../config";
import { loadSystemPromptWithSkills } from "../prompt";
import { writeTextFileAtomic } from "../utils/atomicFile";

import { AgentSession } from "./session/AgentSession";
import { SessionDb } from "./sessionDb";
import {
  WEBSOCKET_PROTOCOL_VERSION,
  safeParseClientMessage,
  type ClientMessage,
  type ServerEvent,
} from "./protocol";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const errorWithCodeSchema = z.object({
  code: z.string().optional(),
}).passthrough();
const websocketMessageRawSchema = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer),
]);

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
  patch: Partial<Pick<AgentConfig, "provider" | "model" | "subAgentModel" | "enableMcp" | "observabilityEnabled">>
): Promise<void> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const configPath = path.join(projectAgentDir, "config.json");
  const current = await loadJsonObjectSafe(configPath);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of entries) {
    next[key] = value;
  }
  await fs.mkdir(projectAgentDir, { recursive: true });
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  await writeTextFileAtomic(configPath, payload);
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

type SessionBinding = {
  session: AgentSession | null;
  socket: Bun.ServerWebSocket<{ session?: AgentSession; resumeSessionId?: string }> | null;
};

export async function startAgentServer(
  opts: StartAgentServerOptions
): Promise<{
  server: ReturnType<typeof Bun.serve>;
  config: AgentConfig;
  system: string;
  url: string;
}> {
  function protocolErrorCode(error: string): ServerErrorCode {
    if (error === "Invalid JSON") return "invalid_json";
    if (error === "Expected object") return "invalid_payload";
    if (error === "Missing type") return "missing_type";
    if (error.startsWith("Unknown type:")) return "unknown_type";
    return "validation_failed";
  }

  const hostname = opts.hostname ?? "127.0.0.1";
  const env = opts.env ?? { ...process.env, AGENT_WORKING_DIR: opts.cwd };

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

  const buildSession = (binding: SessionBinding, persistedSessionId?: string): {
    session: AgentSession;
    isResume: boolean;
    resumedFromStorage: boolean;
  } => {
    const emit = (evt: ServerEvent) => {
      const socket = binding.socket;
      if (!socket) return;
      try {
        socket.send(JSON.stringify(evt));
      } catch {
        // ignore
      }
    };

    const common = {
      discoveredSkills,
      yolo: opts.yolo,
      connectProviderImpl: opts.connectProviderImpl,
      getAiCoworkerPathsImpl,
      runTurnImpl: opts.runTurnImpl,
      persistModelSelectionImpl: async (selection: {
        provider: AgentConfig["provider"];
        model: string;
        subAgentModel: string;
      }) => {
        await persistProjectConfigPatch(config.projectAgentDir, selection);
        config = { ...config, ...selection };
      },
      persistProjectConfigPatchImpl: async (
        patch: Partial<Pick<AgentConfig, "provider" | "model" | "subAgentModel" | "enableMcp" | "observabilityEnabled">>
      ) => {
        await persistProjectConfigPatch(config.projectAgentDir, patch);
        config = { ...config, ...patch };
      },
      sessionDb,
      emit,
    };

    if (persistedSessionId) {
      const persisted = sessionDb.getSessionRecord(persistedSessionId);
      if (persisted) {
        const session = AgentSession.fromPersisted({
          persisted,
          baseConfig: { ...config },
          ...common,
        });
        return { session, isResume: true, resumedFromStorage: true };
      }
    }

    const session = new AgentSession({
      config: { ...config },
      system,
      ...common,
    });
    return { session, isResume: false, resumedFromStorage: false };
  };

  function createServer(port: number): ReturnType<typeof Bun.serve> {
    return Bun.serve<{ session?: AgentSession; resumeSessionId?: string }>({
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

          let session: AgentSession;
          let binding: SessionBinding;
          let isResume = false;
          let resumedFromStorage = false;

          if (resumable && resumable.socket === null && resumable.session) {
            binding = resumable;
            binding.socket = ws;
            session = binding.session;
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

          const hello: ServerEvent = {
            type: "server_hello",
            sessionId: session.id,
            protocolVersion: WEBSOCKET_PROTOCOL_VERSION,
            capabilities: {
              modelStreamChunk: "v1",
            },
            config: session.getPublicConfig(),
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
          // Feature 1: replay pending prompts on reconnect
          if (isResume) {
            session.replayPendingPrompts();
          }
        },
        message(ws, raw) {
          const session = ws.data.session;
          if (!session) return;

          const parsedRaw = websocketMessageRawSchema.safeParse(raw);
          if (!parsedRaw.success) {
            ws.send(
              JSON.stringify({
                type: "error",
                sessionId: session.id,
                message: "Invalid JSON",
                code: "invalid_json",
                source: "protocol",
              } satisfies ServerEvent)
            );
            return;
          }
          const text =
            typeof parsedRaw.data === "string"
              ? parsedRaw.data
              : Buffer.from(parsedRaw.data).toString("utf-8");
          const parsed = safeParseClientMessage(text);
          if (!parsed.ok) {
            ws.send(
              JSON.stringify({
                type: "error",
                sessionId: session.id,
                message: parsed.error,
                code: protocolErrorCode(parsed.error),
                source: "protocol",
              } satisfies ServerEvent)
            );
            return;
          }

          const msg: ClientMessage = parsed.msg;
          if (msg.type === "client_hello") return;

          if (msg.sessionId !== session.id) {
            ws.send(
              JSON.stringify({
                type: "error",
                sessionId: session.id,
                message: `Unknown sessionId: ${msg.sessionId}`,
                code: "unknown_session",
                source: "protocol",
              } satisfies ServerEvent)
            );
            return;
          }

          switch (msg.type) {
            case "ping":
              try { ws.send(JSON.stringify({ type: "pong", sessionId: msg.sessionId } satisfies ServerEvent)); } catch {}
              return;
            case "user_message": return void session.sendUserMessage(msg.text, msg.clientMessageId);
            case "ask_response": return session.handleAskResponse(msg.requestId, msg.answer);
            case "approval_response": return session.handleApprovalResponse(msg.requestId, msg.approved);
            case "set_model": return void session.setModel(msg.model, msg.provider);
            case "refresh_provider_status": return void session.refreshProviderStatus();
            case "provider_catalog_get": return void session.emitProviderCatalog();
            case "provider_auth_methods_get": return session.emitProviderAuthMethods();
            case "provider_auth_authorize": return void session.authorizeProviderAuth(msg.provider, msg.methodId);
            case "provider_auth_callback": return void session.callbackProviderAuth(msg.provider, msg.methodId, msg.code);
            case "provider_auth_set_api_key": return void session.setProviderApiKey(msg.provider, msg.methodId, msg.apiKey);
            case "cancel": return session.cancel();
            case "session_close":
              return void (async () => {
                await session.closeForHistory();
                session.dispose("client requested close");
                sessionBindings.delete(session.id);
                try { ws.close(); } catch {}
              })();
            case "reset": return session.reset();
            case "list_tools": return session.listTools();
            case "list_commands": return void session.listCommands();
            case "execute_command": return void session.executeCommand(msg.name, msg.arguments ?? "", msg.clientMessageId);
            case "list_skills": return void session.listSkills();
            case "read_skill": return void session.readSkill(msg.skillName);
            case "disable_skill": return void session.disableSkill(msg.skillName);
            case "enable_skill": return void session.enableSkill(msg.skillName);
            case "delete_skill": return void session.deleteSkill(msg.skillName);
            case "set_enable_mcp": return void session.setEnableMcp(msg.enableMcp);
            case "mcp_servers_get": return void session.emitMcpServers();
            case "mcp_server_upsert": return void session.upsertMcpServer(msg.server, msg.previousName);
            case "mcp_server_delete": return void session.deleteMcpServer(msg.name);
            case "mcp_server_validate": return void session.validateMcpServer(msg.name);
            case "mcp_server_auth_authorize": return void session.authorizeMcpServerAuth(msg.name);
            case "mcp_server_auth_callback": return void session.callbackMcpServerAuth(msg.name, msg.code);
            case "mcp_server_auth_set_api_key": return void session.setMcpServerApiKey(msg.name, msg.apiKey);
            case "mcp_servers_migrate_legacy": return void session.migrateLegacyMcpServers(msg.scope);
            case "harness_context_get": return session.getHarnessContext();
            case "harness_context_set": return session.setHarnessContext(msg.context);
            case "session_backup_get": return void session.getSessionBackupState();
            case "session_backup_checkpoint": return void session.createManualSessionCheckpoint();
            case "session_backup_restore": return void session.restoreSessionBackup(msg.checkpointId);
            case "session_backup_delete_checkpoint": return void session.deleteSessionCheckpoint(msg.checkpointId);
            case "get_messages": return session.getMessages(msg.offset, msg.limit);
            case "set_session_title": return session.setSessionTitle(msg.title);
            case "list_sessions": return void session.listSessions();
            case "delete_session": return void session.deleteSession(msg.targetSessionId);
            case "set_config": return void session.setConfig(msg.config);
            case "upload_file": return void session.uploadFile(msg.filename, msg.contentBase64);
          }
        },
        close(ws) {
          const session = ws.data.session;
          if (!session) return;
          const binding = sessionBindings.get(session.id);
          if (!binding) return;

          if (binding.socket === ws) {
            binding.socket = null;
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
  const originalStop = server.stop.bind(server);
  let serverStopped = false;
  const stoppableServer = server as typeof server & { stop: () => void };
  stoppableServer.stop = () => {
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
    return originalStop();
  };

  const url = `ws://${hostname}:${server.port}/ws`;
  return { server, config, system, url };
}
