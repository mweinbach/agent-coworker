import fs from "node:fs/promises";

import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../connect";
import type { runTurn as runTurnFn } from "../agent";
import type { AgentConfig } from "../types";
import type { ServerErrorCode } from "../types";
import { loadConfig } from "../config";
import { loadSystemPromptWithSkills } from "../prompt";

import { AgentSession } from "./session";
import {
  WEBSOCKET_PROTOCOL_VERSION,
  safeParseClientMessage,
  type ClientMessage,
  type ServerEvent,
} from "./protocol";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  session: AgentSession;
  socket: Bun.ServerWebSocket<{ session?: AgentSession; resumeSessionId?: string }> | null;
  disposeTimer: ReturnType<typeof setTimeout> | null;
};

const RESUME_SESSION_TTL_MS = 60_000;

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
  const config = await loadConfig({ cwd: opts.cwd, env, homedir: opts.homedir, builtInDir });
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
  await fs.mkdir(config.outputDirectory, { recursive: true });
  await fs.mkdir(config.uploadsDirectory, { recursive: true });

  const { prompt: system, discoveredSkills } = await loadSystemPromptWithSkills(config);
  const sessionBindings = new Map<string, SessionBinding>();

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

          if (resumable && resumable.socket === null) {
            binding = resumable;
            binding.socket = ws;
            if (binding.disposeTimer) {
              clearTimeout(binding.disposeTimer);
              binding.disposeTimer = null;
            }
            session = binding.session;
          } else {
            binding = {
              session: undefined as unknown as AgentSession,
              socket: ws,
              disposeTimer: null,
            };
            session = new AgentSession({
              config,
              system,
              discoveredSkills,
              yolo: opts.yolo,
              connectProviderImpl: opts.connectProviderImpl,
              getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl,
              runTurnImpl: opts.runTurnImpl,
              emit: (evt: ServerEvent) => {
                const socket = binding.socket;
                if (!socket) return;
                try {
                  socket.send(JSON.stringify(evt));
                } catch {
                  // ignore
                }
              },
            });
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
          };

          ws.send(JSON.stringify(hello));

          const settings: ServerEvent = {
            type: "session_settings",
            sessionId: session.id,
            enableMcp: session.getEnableMcp(),
          };
          ws.send(JSON.stringify(settings));

          ws.send(JSON.stringify(session.getObservabilityStatusEvent()));
          void session.emitProviderCatalog();
          session.emitProviderAuthMethods();
          void session.refreshProviderStatus();
        },
        message(ws, raw) {
          const session = ws.data.session;
          if (!session) return;

          const text = typeof raw === "string" ? raw : Buffer.from(raw as any).toString("utf-8");
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

          if (msg.type === "ping") {
            try {
              ws.send(JSON.stringify({ type: "pong", sessionId: msg.sessionId } satisfies ServerEvent));
            } catch {
              // ignore
            }
            return;
          }

          if (msg.type === "user_message") {
            void session.sendUserMessage(msg.text, msg.clientMessageId);
            return;
          }

          if (msg.type === "ask_response") {
            session.handleAskResponse(msg.requestId, msg.answer);
            return;
          }

          if (msg.type === "approval_response") {
            session.handleApprovalResponse(msg.requestId, msg.approved);
            return;
          }

          if (msg.type === "set_model") {
            void session.setModel(msg.model, msg.provider);
            return;
          }

          if (msg.type === "refresh_provider_status") {
            void session.refreshProviderStatus();
            return;
          }

          if (msg.type === "provider_catalog_get") {
            void session.emitProviderCatalog();
            return;
          }

          if (msg.type === "provider_auth_methods_get") {
            session.emitProviderAuthMethods();
            return;
          }

          if (msg.type === "provider_auth_authorize") {
            void session.authorizeProviderAuth(msg.provider, msg.methodId);
            return;
          }

          if (msg.type === "provider_auth_callback") {
            void session.callbackProviderAuth(msg.provider, msg.methodId, msg.code);
            return;
          }

          if (msg.type === "provider_auth_set_api_key") {
            void session.setProviderApiKey(msg.provider, msg.methodId, msg.apiKey);
            return;
          }

          if (msg.type === "cancel") {
            session.cancel();
            return;
          }

          if (msg.type === "reset") {
            session.reset();
            return;
          }

          if (msg.type === "list_tools") {
            session.listTools();
            return;
          }

          if (msg.type === "list_commands") {
            void session.listCommands();
            return;
          }

          if (msg.type === "execute_command") {
            void session.executeCommand(msg.name, msg.arguments ?? "", msg.clientMessageId);
            return;
          }

          if (msg.type === "list_skills") {
            void session.listSkills();
            return;
          }

          if (msg.type === "read_skill") {
            void session.readSkill(msg.skillName);
            return;
          }

          if (msg.type === "disable_skill") {
            void session.disableSkill(msg.skillName);
            return;
          }

          if (msg.type === "enable_skill") {
            void session.enableSkill(msg.skillName);
            return;
          }

          if (msg.type === "delete_skill") {
            void session.deleteSkill(msg.skillName);
            return;
          }

          if (msg.type === "set_enable_mcp") {
            session.setEnableMcp(msg.enableMcp);
            return;
          }

          if (msg.type === "harness_context_get") {
            session.getHarnessContext();
            return;
          }

          if (msg.type === "harness_context_set") {
            session.setHarnessContext(msg.context);
            return;
          }

          if (msg.type === "session_backup_get") {
            void session.getSessionBackupState();
            return;
          }

          if (msg.type === "session_backup_checkpoint") {
            void session.createManualSessionCheckpoint();
            return;
          }

          if (msg.type === "session_backup_restore") {
            void session.restoreSessionBackup(msg.checkpointId);
            return;
          }

          if (msg.type === "session_backup_delete_checkpoint") {
            void session.deleteSessionCheckpoint(msg.checkpointId);
            return;
          }
        },
        close(ws) {
          const session = ws.data.session;
          if (!session) return;
          const binding = sessionBindings.get(session.id);
          if (!binding) {
            session.dispose("websocket closed");
            return;
          }

          if (binding.socket === ws) {
            binding.socket = null;
          }

          if (binding.disposeTimer) clearTimeout(binding.disposeTimer);
          binding.disposeTimer = setTimeout(() => {
            if (binding.socket) return;
            binding.session.dispose("websocket closed");
            sessionBindings.delete(binding.session.id);
          }, RESUME_SESSION_TTL_MS);
        },
      },
    });
  }

  function isAddrInUse(err: unknown): boolean {
    const code = (err as any)?.code;
    return code === "EADDRINUSE";
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

  const url = `ws://${hostname}:${server.port}/ws`;
  return { server, config, system, url };
}
