import { createAgentServerRuntime, type StartAgentServerOptions } from "./runtime/ServerRuntime";
import type { StartServerSocketData } from "./startServer/types";
import { startH3MobileServer } from "./transport/h3/server";
import { handleWebDesktopRoute } from "./webDesktopRoutes";
import { WebDesktopService } from "./webDesktopService";
import { resolveWsProtocol, splitWebSocketSubprotocolHeader } from "./wsProtocol/negotiation";

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

function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function startAgentServer(opts: StartAgentServerOptions): Promise<{
  server: ReturnType<typeof Bun.serve>;
  mobileServer?: Awaited<ReturnType<typeof startH3MobileServer>>;
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
  let mobileServer: Awaited<ReturnType<typeof startH3MobileServer>> | undefined;

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
        if (req.method === "DELETE" && url.pathname.startsWith("/mobile-h3/trusted/")) {
          if (!mobileServer) {
            return Response.json({ error: "Mobile H3 endpoint is not running." }, { status: 404 });
          }
          if (parseBearerToken(req.headers.get("authorization")) !== mobileServer.adminToken) {
            return Response.json({ error: "Unauthorized." }, { status: 401 });
          }
          const deviceId = decodeURIComponent(url.pathname.slice("/mobile-h3/trusted/".length));
          const removed = await mobileServer.revokeTrustedDevice(deviceId);
          return Response.json({ ok: true, removed });
        }
        if (req.method === "DELETE" && url.pathname === "/mobile-h3/trusted") {
          if (!mobileServer) {
            return Response.json({ error: "Mobile H3 endpoint is not running." }, { status: 404 });
          }
          if (parseBearerToken(req.headers.get("authorization")) !== mobileServer.adminToken) {
            return Response.json({ error: "Unauthorized." }, { status: 401 });
          }
          await mobileServer.revokeTrustedDevices();
          return Response.json({ ok: true });
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
  try {
    mobileServer =
      opts.mobileH3 || runtime.env.COWORK_H3_MOBILE_PAIRING === "1"
        ? await startH3MobileServer({
            runtime,
            hostname: opts.mobileH3?.hostname ?? "0.0.0.0",
            port: opts.mobileH3?.port,
            hostHints: opts.mobileH3?.hostHints,
            storeRootPath: opts.homedir,
            enableH3: runtime.env.COWORK_H3_MOBILE_DISABLE_H3 !== "1",
          })
        : undefined;
  } catch (error) {
    await runtime.stop().catch(() => {
      // ignore cleanup errors during failed startup
    });
    await webDesktopService?.stopAll().catch(() => {
      // ignore cleanup errors during failed startup
    });
    await Promise.resolve(server.stop(true)).catch(() => {
      // ignore cleanup errors during failed startup
    });
    throw error;
  }
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
    await mobileServer?.stop().catch(() => {
      // ignore
    });
    try {
      await webDesktopService?.stopAll();
    } catch {
      // ignore
    }
    await originalStop(closeActiveConnections);
  };

  const url = `ws://${hostname}:${server.port}/ws`;
  return {
    server: stoppableServer,
    mobileServer,
    config: runtime.config,
    system: runtime.system,
    url,
  };
}
