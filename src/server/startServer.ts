import fs from "node:fs/promises";

import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../connect";
import type { AgentConfig } from "../types";
import { loadConfig } from "../config";
import { loadSystemPrompt } from "../prompt";

import { AgentSession } from "./session";
import { safeParseClientMessage, type ClientMessage, type ServerEvent } from "./protocol";

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
  const env = opts.env ?? { ...process.env, AGENT_WORKING_DIR: opts.cwd };

  const config = await loadConfig({ cwd: opts.cwd, env, homedir: opts.homedir });
  if (opts.providerOptions) config.providerOptions = opts.providerOptions;

  await fs.mkdir(config.projectAgentDir, { recursive: true });
  await fs.mkdir(config.outputDirectory, { recursive: true });
  await fs.mkdir(config.uploadsDirectory, { recursive: true });

  const system = await loadSystemPrompt(config);

  function createServer(port: number): ReturnType<typeof Bun.serve> {
    return Bun.serve<{ session?: AgentSession }>({
      hostname,
      port,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const upgraded = srv.upgrade(req, { data: {} });
          if (upgraded) return;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return new Response("OK", { status: 200 });
      },
      websocket: {
        open(ws) {
          const session = new AgentSession({
            config,
            system,
            yolo: opts.yolo,
            connectProviderImpl: opts.connectProviderImpl,
            getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl,
            emit: (evt: ServerEvent) => {
              try {
                ws.send(JSON.stringify(evt));
              } catch {
                // ignore
              }
            },
          });

          ws.data.session = session;

          const hello: ServerEvent = {
            type: "server_hello",
            sessionId: session.id,
            config: session.getPublicConfig(),
          };

          ws.send(JSON.stringify(hello));
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
              } satisfies ServerEvent)
            );
            return;
          }

          if (msg.type === "user_message") {
            session.sendUserMessage(msg.text, msg.clientMessageId);
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

          if (msg.type === "connect_provider") {
            void session.connectProvider(msg.provider, msg.apiKey);
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
        },
        close(ws) {
          ws.data.session?.dispose("websocket closed");
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
