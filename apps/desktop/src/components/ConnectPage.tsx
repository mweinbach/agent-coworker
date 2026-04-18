import { useCallback, useEffect, useRef, useState } from "react";
import {
  configureWebAdapter,
  createWebAdapter,
  deriveSameOriginServerUrl,
  normalizeWebServerUrl,
} from "../lib/webAdapter";
import { getSavedServerUrl } from "../lib/webWorkspaceState";

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
  const res = await fetch(`${base}/cowork/workspaces`);
  if (!res.ok) throw new Error(`Server returned ${res.status} from /cowork/workspaces`);
  const data = (await res.json()) as { workspaces?: DiscoveredWorkspace[] };
  return Array.isArray(data.workspaces) ? data.workspaces : [];
}

async function supportsDesktopService(serverWsUrl: string): Promise<boolean> {
  const base = toHttpBase(serverWsUrl);
  const res = await fetch(`${base}/cowork/desktop/state`);
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
      ws = new WebSocket(url, "cowork.jsonrpc.v1");
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error(`Timed out after ${timeoutMs}ms connecting to ${url}`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
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

export function ConnectPage({ onConnect, initialError = null, initialServerUrl = null }: ConnectPageProps) {
  const defaultUrl = normalizeWebServerUrl(initialServerUrl ?? getSavedServerUrl() ?? deriveSameOriginServerUrl());
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
          throw new Error("Server is running but reports no workspace. Restart it with --dir <path>.");
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
    [connectWithPath],
  );

  // On first mount, try the auto-connect flow (same-origin URL should Just Work behind Vite proxy).
  useEffect(() => {
    if (triedAutoConnect.current) return;
    triedAutoConnect.current = true;
    void connectViaDiscovery(serverUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = () => {
    void connectViaDiscovery(serverUrl);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !busy && serverUrl) {
      handleConnect();
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--surface-window)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          width: 420,
          padding: 32,
          borderRadius: 12,
          background: "var(--surface-base)",
          border: "1px solid var(--border-default)",
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, marginBottom: 4 }}>Cowork</h1>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            margin: 0,
            marginBottom: 20,
          }}
        >
          Connect to a running Cowork server
        </p>

        {discovered.length > 1 ? (
          <>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, marginBottom: 8 }}>
              Select a workspace:
            </p>
            <div style={{ marginBottom: 16 }}>
              {discovered.map((ws) => (
                <button
                  key={ws.path}
                  onClick={() => void connectWithPath(serverUrl, ws.path)}
                  disabled={busy}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--border-default)",
                    background: "transparent",
                    color: "var(--text-primary)",
                    fontSize: 13,
                    marginBottom: 4,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  <strong>{ws.name}</strong>
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {ws.path}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        <button
          onClick={handleConnect}
          disabled={busy || !serverUrl}
          style={{
            width: "100%",
            padding: "10px 16px",
            borderRadius: 6,
            border: "none",
            background: busy ? "var(--border-default)" : "var(--accent)",
            color: "var(--text-inverse)",
            fontSize: 13,
            fontWeight: 500,
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.7 : 1,
            marginBottom: 12,
          }}
        >
          {busy ? (status ?? "Connecting…") : "Connect"}
        </button>

        {status && !error ? (
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, marginBottom: 12 }}>
            {status}
          </p>
        ) : null}

        {error ? (
          <p style={{ fontSize: 12, color: "var(--danger)", margin: 0, marginBottom: 12 }}>{error}</p>
        ) : null}

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            marginBottom: showAdvanced ? 12 : 0,
          }}
        >
          {showAdvanced ? "Hide advanced" : "Advanced…"}
        </button>

        {showAdvanced ? (
          <>
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 500,
                marginBottom: 6,
                color: "var(--text-secondary)",
              }}
            >
              Server URL
            </label>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="ws://127.0.0.1:7337/ws"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px solid var(--border-default)",
                background: "var(--surface-base)",
                color: "var(--text-primary)",
                fontSize: 13,
                marginBottom: 8,
                outline: "none",
              }}
            />
            <p
              style={{
                fontSize: 11,
                color: "var(--text-tertiary)",
                margin: 0,
              }}
            >
              Defaults to same-origin via the Vite dev proxy. Override to point at a different Cowork server.
            </p>
          </>
        ) : null}

        <p
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            marginTop: 16,
            marginBottom: 0,
          }}
        >
          Tip: <code style={{ fontSize: 11 }}>bun run desktop:web -- --dir /path/to/project</code>
        </p>
      </div>
    </div>
  );
}
