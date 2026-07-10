import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserAccessHeaders,
  configureWebAdapter,
  createWebAdapter,
  deriveSameOriginServerUrl,
  normalizeWebServerUrl,
  withBrowserAccessToken,
} from "../lib/webAdapter";
import { getSavedServerUrl } from "../lib/webWorkspaceState";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type ConnectPageProps = {
  onConnect: () => void;
  initialError?: string | null;
  initialServerUrl?: string | null;
};

type DiscoveredWorkspace = { name: string; path: string };

// Turn a ws:// URL into the matching http:// URL (strips the /ws suffix if present).
function toHttpBase(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const httpProto = u.protocol === "wss:" ? "https:" : "http:";
    const base = `${httpProto}//${u.host}`;
    return base;
  } catch {
    return wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  }
}

// Fetch the server's declared workspace (its --dir). One HTTP hop that also verifies reachability.
async function fetchServerWorkspaces(serverWsUrl: string): Promise<DiscoveredWorkspace[]> {
  const base = toHttpBase(serverWsUrl);
  const res = await fetch(`${base}/cowork/workspaces`, { headers: browserAccessHeaders() });
  if (!res.ok) throw new Error(`Server returned ${res.status} from /cowork/workspaces`);
  const data = (await res.json()) as { workspaces?: DiscoveredWorkspace[] };
  return Array.isArray(data.workspaces) ? data.workspaces : [];
}

async function supportsDesktopService(serverWsUrl: string): Promise<boolean> {
  const base = toHttpBase(serverWsUrl);
  const res = await fetch(`${base}/cowork/desktop/state`, { headers: browserAccessHeaders() });
  return res.ok;
}

// Open a WebSocket with the jsonrpc subprotocol and resolve once the handshake succeeds (or reject
// on any close/error before that). Catches config mistakes (wrong port, wrong subprotocol, server
// not running) *before* we hand control to the main app.
function probeWebSocket(url: string, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(withBrowserAccessToken(url), "cowork.jsonrpc.v1");
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore close races after timeout
      }
      reject(new Error(`Timed out after ${timeoutMs}ms connecting to ${url}`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close races after open
      }
      resolve();
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to connect to ${url}. Is the server running?`));
    });
    ws.addEventListener("close", (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Connection closed (${ev.code}) before handshake completed.`));
    });
  });
}

export function ConnectPage({
  onConnect,
  initialError = null,
  initialServerUrl = null,
}: ConnectPageProps) {
  const defaultUrl = normalizeWebServerUrl(
    initialServerUrl ?? getSavedServerUrl() ?? deriveSameOriginServerUrl(),
  );
  const [serverUrl, setServerUrl] = useState(defaultUrl);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [discovered, setDiscovered] = useState<DiscoveredWorkspace[]>([]);
  const triedAutoConnect = useRef(false);

  const connectWithPath = useCallback(
    async (url: string, workspacePath: string) => {
      const normalizedUrl = normalizeWebServerUrl(url);
      setBusy(true);
      setError(null);
      try {
        setStatus("Checking server…");
        await probeWebSocket(normalizedUrl);
        configureWebAdapter(normalizedUrl, workspacePath);
        window.cowork = createWebAdapter();
        setStatus(null);
        onConnect();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus(null);
        setBusy(false);
      }
    },
    [onConnect],
  );

  // Ask the server what path it's serving, then connect. Single-click Connect flow.
  const connectViaDiscovery = useCallback(
    async (url: string) => {
      const normalizedUrl = normalizeWebServerUrl(url);
      setBusy(true);
      setError(null);
      try {
        setStatus("Checking server…");
        await probeWebSocket(normalizedUrl);

        setStatus("Loading desktop state…");
        if (await supportsDesktopService(normalizedUrl)) {
          configureWebAdapter(normalizedUrl, "");
          window.cowork = createWebAdapter();
          setStatus(null);
          onConnect();
          return;
        }

        setStatus("Finding workspace…");
        const workspaces = await fetchServerWorkspaces(normalizedUrl);
        if (workspaces.length === 0) {
          throw new Error(
            "Server is running but reports no workspace. Restart it with --dir <path>.",
          );
        }
        if (workspaces.length > 1) {
          // Surface the picker; don't auto-pick.
          setDiscovered(workspaces);
          setStatus(null);
          setBusy(false);
          return;
        }
        await connectWithPath(normalizedUrl, workspaces[0].path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus(null);
        setBusy(false);
      }
    },
    [connectWithPath, onConnect],
  );

  // On first mount, try the auto-connect flow (same-origin URL should Just Work behind Vite proxy).
  useEffect(() => {
    if (triedAutoConnect.current) return;
    triedAutoConnect.current = true;
    void connectViaDiscovery(serverUrl);
  }, [connectViaDiscovery, serverUrl]);

  const handleConnect = () => {
    void connectViaDiscovery(serverUrl);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !busy && serverUrl) {
      handleConnect();
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-[420px] rounded-xl border border-border bg-card p-8 shadow-sm">
        <h1 className="m-0 mb-1 text-xl font-semibold tracking-tight">Cowork</h1>
        <p className="mb-5 text-[13px] text-muted-foreground">Connect to a running Cowork server</p>

        {discovered.length > 1 ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">Select a workspace:</p>
            <div className="mb-4 flex flex-col gap-1">
              {discovered.map((ws) => (
                <Button
                  type="button"
                  key={ws.path}
                  variant="outline"
                  onClick={() => void connectWithPath(serverUrl, ws.path)}
                  disabled={busy}
                  className="h-auto w-full flex-col items-start justify-start gap-0.5 px-3 py-2 text-left whitespace-normal"
                >
                  <span className="text-[13px] font-semibold text-foreground">{ws.name}</span>
                  <span className="text-[11px] font-normal text-muted-foreground">{ws.path}</span>
                </Button>
              ))}
            </div>
          </>
        ) : null}

        <Button
          type="button"
          onClick={handleConnect}
          disabled={busy || !serverUrl}
          className="mb-3 w-full"
        >
          {busy ? (status ?? "Connecting…") : "Connect"}
        </Button>

        {status && !error ? <p className="mb-3 text-xs text-muted-foreground">{status}</p> : null}

        {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className={`bg-transparent p-0 text-[11px] text-muted-foreground hover:text-foreground ${
            showAdvanced ? "mb-3" : ""
          }`}
        >
          {showAdvanced ? "Hide advanced" : "Advanced…"}
        </button>

        {showAdvanced ? (
          <div className="flex flex-col gap-2">
            <label
              htmlFor="connect-server-url"
              className="text-xs font-medium text-muted-foreground"
            >
              Server URL
            </label>
            <Input
              id="connect-server-url"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="ws://127.0.0.1:7337/ws"
            />
            <p className="m-0 text-[11px] text-muted-foreground">
              Defaults to same-origin via the Vite dev proxy. Override to point at a different
              Cowork server.
            </p>
          </div>
        ) : null}

        <p className="mt-4 mb-0 text-[11px] text-muted-foreground">
          Tip: <code className="text-[11px]">bun run desktop:web -- --dir /path/to/project</code>
        </p>
      </div>
    </div>
  );
}
