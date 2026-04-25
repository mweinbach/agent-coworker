import { createAgentServerRuntime, type StartAgentServerOptions } from "./runtime/ServerRuntime";
import { handleWebDesktopRoute } from "./webDesktopRoutes";
import { WebDesktopService } from "./webDesktopService";
import { resolveWsProtocol, splitWebSocketSubprotocolHeader } from "./wsProtocol/negotiation";
import type { StartServerSocketData } from "./startServer/types";

export type { StartAgentServerOptions } from "./runtime/ServerRuntime";

function pickLoopbackOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const u = new URL(origin);
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return origin;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function startAgentServer(opts: StartAgentServerOptions): Promise<{
  server: ReturnType<typeof Bun.serve>;
  config: ReturnType<typeof createAgentServerRuntime> extends Promise<infer Runtime>
    ? Runtime extends { config: infer Config }
      ? Config
      : never
    : never;
  system: string;
  url: string;
}> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const runtime = await createAgentServerRuntime(opts);
  const requestedPort = opts.port ?? 7337;
  const webDesktopService =
    runtime.env.COWORK_WEB_DESKTOP_SERVICE === "1"
      ? new WebDesktopService({ homedir: opts.homedir })
      : null;

  const createServer = (port: number): ReturnType<typeof Bun.serve> =>
    Bun.serve<StartServerSocketData>({
      hostname,
      port,
      async fetch(req, srv) {
        const url = new URL(req.url);
        const allowedOrigin = pickLoopbackOrigin(req);
        const corsHeaders: Record<string, string> = allowedOrigin
          ? {
              "Access-Control-Allow-Origin": allowedOrigin,
              Vary: "Origin",
            }
          : {};
        if (req.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              ...corsHeaders,
              "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Sec-WebSocket-Protocol",
              "Access-Control-Max-Age": "86400",
            },
          });
        }
        if (url.pathname === "/ws") {
          const resumeSessionIdRaw = url.searchParams.get("resumeSessionId");
          const resumeSessionId = resumeSessionIdRaw?.trim()
            ? resumeSessionIdRaw.trim()
            : undefined;
          const protocolResult = resolveWsProtocol({
            offeredSubprotocols: splitWebSocketSubprotocolHeader(
              req.headers.get("sec-websocket-protocol"),
            ),
            requestedProtocol: url.searchParams.get("protocol"),
          });
          if (!protocolResult.ok) {
            return new Response(protocolResult.error, { status: 400, headers: corsHeaders });
          }
          const upgraded = srv.upgrade(req, {
            headers: protocolResult.protocol.selectedSubprotocol
              ? {
                  "Sec-WebSocket-Protocol": protocolResult.protocol.selectedSubprotocol,
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
          return new Response("WebSocket upgrade failed", { status: 400, headers: corsHeaders });
        }
        const webDesktopRoute = await handleWebDesktopRoute(req, {
          cwd: opts.cwd,
          desktopService: webDesktopService,
        });
        if (webDesktopRoute) {
          for (const [key, value] of Object.entries(corsHeaders)) {
            webDesktopRoute.headers.set(key, value);
          }
          return webDesktopRoute;
        }
        return new Response("OK", { status: 200, headers: corsHeaders });
      },
      websocket: {
        open(ws) {
          runtime.openConnection(ws);
        },
        message(ws, raw) {
          runtime.handleMessage(ws, raw);
        },
        close(ws) {
          runtime.closeConnection(ws);
        },
        drain(ws) {
          runtime.drainConnection(ws);
        },
      },
    });

  const serveWithPortFallback = (port: number): ReturnType<typeof Bun.serve> => {
    try {
      return createServer(port);
    } catch (err) {
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
          if (runtime.isAddrInUse(e)) continue;
          throw e;
        }
      }
      throw lastErr;
    }
  };

  const server = serveWithPortFallback(requestedPort);
  const originalStop = server.stop.bind(server) as (
    closeActiveConnections?: boolean,
  ) => Promise<void>;
  const evictionTimer = runtime.startIdleEviction();
  const stoppableServer = server as typeof server & {
    stop: (closeActiveConnections?: boolean) => Promise<void>;
  };
  let stopped = false;
  stoppableServer.stop = async (closeActiveConnections?: boolean) => {
    if (stopped) return;
    stopped = true;
    clearInterval(evictionTimer);
    await runtime.stop();
    try {
      await webDesktopService?.stopAll();
    } catch {
      // ignore
    }
    await originalStop(closeActiveConnections);
  };

  const url = `ws://${hostname}:${server.port}/ws`;
  return { server: stoppableServer, config: runtime.config, system: runtime.system, url };
}
