import { createAgentServerRuntime, type StartAgentServerOptions } from "./runtime/ServerRuntime";
import type { StartServerSocketData } from "./startServer/types";
import type { startH3MobileServer as startH3MobileServerType } from "./transport/h3/server";
import { handleWebDesktopRoute } from "./webDesktopRoutes";
import { WebDesktopService } from "./webDesktopService";
import { resolveWsProtocol, splitWebSocketSubprotocolHeader } from "./wsProtocol/negotiation";

export type { StartAgentServerOptions } from "./runtime/ServerRuntime";

type H3MobileServer = Awaited<ReturnType<typeof startH3MobileServerType>>;

async function loadH3MobileServerStarter(): Promise<typeof startH3MobileServerType> {
  const { startH3MobileServer } = await import("./transport/h3/server");
  return startH3MobileServer;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  const bareHostname =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  return bareHostname === "localhost" || bareHostname === "127.0.0.1" || bareHostname === "::1";
}

function createBrowserAccessToken(): string {
  return crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
}

function pickLoopbackOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (isLoopbackHostname(u.hostname)) {
      return origin;
    }
  } catch {
    // fall through
  }
  return null;
}

function isFileBrowserOrigin(origin: string | null): boolean {
  const normalized = origin?.trim().toLowerCase();
  return normalized === "null" || Boolean(normalized?.startsWith("file://"));
}

function hasUntrustedBrowserOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return Boolean(origin && !pickLoopbackOrigin(origin) && !isFileBrowserOrigin(origin));
}

function readBrowserAccessToken(url: URL, req: Request): string | null {
  const headerToken = req.headers.get("x-cowork-browser-token")?.trim();
  if (headerToken) return headerToken;
  const queryToken = url.searchParams.get("coworkBrowserToken")?.trim();
  return queryToken || null;
}

function isProtectedServerPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/cowork");
}

function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function startAgentServer(opts: StartAgentServerOptions): Promise<{
  server: ReturnType<typeof Bun.serve>;
  mobileServer?: H3MobileServer;
  config: ReturnType<typeof createAgentServerRuntime> extends Promise<infer Runtime>
    ? Runtime extends { config: infer Config }
      ? Config
      : never
    : never;
  system: string;
  url: string;
  browserAccessToken?: string;
}> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const networkExposedListener = !isLoopbackHostname(hostname);
  const env = opts.env ?? { ...process.env, AGENT_WORKING_DIR: opts.cwd };
  const webDesktopService =
    env.COWORK_WEB_DESKTOP_SERVICE === "1"
      ? new WebDesktopService({
          homedir: opts.homedir,
          userDataDir: env.COWORK_DESKTOP_USER_DATA_DIR,
        })
      : null;
  const runtime = await createAgentServerRuntime({
    ...opts,
    env,
    desktopService: webDesktopService,
  });
  const requestedPort = opts.port ?? 7337;
  const browserAccessToken =
    runtime.env.COWORK_BROWSER_ACCESS_TOKEN?.trim() ||
    (webDesktopService || networkExposedListener ? createBrowserAccessToken() : "");
  let mobileServer: H3MobileServer | undefined;
  // Flipped true once startAgentServer finishes its full boot (mobile server +
  // idle eviction). The health endpoint reports it as `startup.ready`, so a
  // supervisor can tell "listening but not fully wired" from "ready".
  let startupReady = false;

  const createServer = (port: number): ReturnType<typeof Bun.serve> =>
    Bun.serve<StartServerSocketData>({
      hostname,
      port,
      async fetch(req, srv) {
        const url = new URL(req.url);
        const allowedOrigin = pickLoopbackOrigin(req.headers.get("origin"));
        const corsHeaders: Record<string, string> = allowedOrigin
          ? {
              "Access-Control-Allow-Origin": allowedOrigin,
              Vary: "Origin",
            }
          : {};
        const browserOrigin = req.headers.get("origin");
        if (hasUntrustedBrowserOrigin(req)) {
          return new Response("Forbidden origin", { status: 403, headers: corsHeaders });
        }
        if (req.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              ...corsHeaders,
              "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
              "Access-Control-Allow-Headers":
                "Authorization, Content-Type, Sec-WebSocket-Protocol, X-Cowork-Browser-Token",
              "Access-Control-Max-Age": "86400",
            },
          });
        }
        if (isProtectedServerPath(url.pathname) && (browserOrigin || networkExposedListener)) {
          if (!browserAccessToken) {
            return new Response("Browser access is not enabled for this server", {
              status: 403,
              headers: corsHeaders,
            });
          }
          if (readBrowserAccessToken(url, req) !== browserAccessToken) {
            return new Response(
              browserOrigin ? "Unauthorized browser access" : "Unauthorized server access",
              {
                status: 401,
                headers: corsHeaders,
              },
            );
          }
        }
        if (req.method === "GET" && url.pathname === "/cowork/health") {
          return Response.json(
            { ...runtime.getHealthSnapshot(), startup: { ready: startupReady } },
            { headers: corsHeaders },
          );
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
        if (req.method === "GET" && url.pathname === "/mobile-h3/trusted") {
          if (!mobileServer) {
            return Response.json({ error: "Mobile H3 endpoint is not running." }, { status: 404 });
          }
          if (parseBearerToken(req.headers.get("authorization")) !== mobileServer.adminToken) {
            return Response.json({ error: "Unauthorized." }, { status: 401 });
          }
          return Response.json({ trustedDevices: await mobileServer.listTrustedDevices() });
        }
        if (
          req.method === "PATCH" &&
          url.pathname.startsWith("/mobile-h3/trusted/") &&
          url.pathname.endsWith("/permissions")
        ) {
          if (!mobileServer) {
            return Response.json({ error: "Mobile H3 endpoint is not running." }, { status: 404 });
          }
          if (parseBearerToken(req.headers.get("authorization")) !== mobileServer.adminToken) {
            return Response.json({ error: "Unauthorized." }, { status: 401 });
          }
          const encodedDeviceId = url.pathname.slice(
            "/mobile-h3/trusted/".length,
            -"/permissions".length,
          );
          const deviceId = decodeURIComponent(encodedDeviceId);
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          const rawPermissions =
            body?.permissions &&
            typeof body.permissions === "object" &&
            !Array.isArray(body.permissions)
              ? (body.permissions as Record<string, unknown>)
              : {};
          const updated = await mobileServer.updateTrustedDevicePermissions(
            deviceId,
            Object.fromEntries(
              Object.entries(rawPermissions)
                .filter(([, value]) => typeof value === "boolean")
                .map(([key, value]) => [key, value === true]),
            ),
          );
          if (!updated) {
            return Response.json({ error: "Trusted device not found." }, { status: 404 });
          }
          return Response.json({ trustedDevice: updated });
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
        maxPayloadLength: 4 * 1024 * 1024, // 4 MB — cap inbound frames to prevent memory exhaustion
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
    if (opts.mobileH3 || runtime.env.COWORK_H3_MOBILE_PAIRING === "1") {
      const startH3MobileServer = await loadH3MobileServerStarter();
      mobileServer = await startH3MobileServer({
        runtime,
        hostname: opts.mobileH3?.hostname ?? "0.0.0.0",
        port: opts.mobileH3?.port,
        hostHints: opts.mobileH3?.hostHints,
        storeRootPath: opts.homedir,
        enableH3: runtime.env.COWORK_H3_MOBILE_DISABLE_H3 !== "1",
        rotateTls: runtime.env.COWORK_H3_ROTATE_TLS === "1",
      });
    }
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

  startupReady = true;
  const url = `ws://${hostname}:${server.port}/ws`;
  return {
    server: stoppableServer,
    mobileServer,
    config: runtime.config,
    system: runtime.system,
    url,
    ...(browserAccessToken ? { browserAccessToken } : {}),
  };
}
