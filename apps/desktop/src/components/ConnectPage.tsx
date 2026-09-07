import { useCallback, useEffect, useRef, useState } from "react";
import { isImeComposing } from "../lib/keyboard";
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

type ConnectionState =
  | { kind: "idle"; error: string | null }
  | { kind: "connecting"; status: string }
  | { kind: "choosing-workspace"; serverUrl: string; workspaces: DiscoveredWorkspace[] };

type ConnectionAttempt = {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
};

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
async function fetchServerWorkspaces(
  serverWsUrl: string,
  signal: AbortSignal,
): Promise<DiscoveredWorkspace[]> {
  const base = toHttpBase(serverWsUrl);
  const res = await fetch(`${base}/cowork/workspaces`, {
    headers: browserAccessHeaders(serverWsUrl),
    signal,
  });
  if (!res.ok) throw new Error(`Server returned ${res.status} from /cowork/workspaces`);
  const data = (await res.json()) as { workspaces?: DiscoveredWorkspace[] };
  return Array.isArray(data.workspaces) ? data.workspaces : [];
}

async function supportsDesktopService(serverWsUrl: string, signal: AbortSignal): Promise<boolean> {
  const base = toHttpBase(serverWsUrl);
  const res = await fetch(`${base}/cowork/desktop/state`, {
    headers: browserAccessHeaders(serverWsUrl),
    signal,
  });
  return res.ok;
}

// Open a WebSocket with the jsonrpc subprotocol and resolve once the handshake succeeds (or reject
// on any close/error before that). Catches config mistakes (wrong port, wrong subprotocol, server
// not running) *before* we hand control to the main app.
function probeWebSocket(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(withBrowserAccessToken(url), "cowork.jsonrpc.v1");
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      try {
        ws.close();
      } catch {
        // The peer may already have closed the probe.
      }
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(signal.reason);
    const onOpen = () => finish();
    const onError = () =>
      finish(new Error("Failed to connect. Check the server address and that Cowork is running."));
    const onClose = (event: CloseEvent) =>
      finish(new Error(`Connection closed (${event.code}) before handshake completed.`));
    signal.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

export function ConnectPage({
  onConnect,
  initialError = null,
  initialServerUrl = null,
}: ConnectPageProps) {
  const [serverUrl, setServerUrl] = useState(() =>
    normalizeWebServerUrl(initialServerUrl ?? getSavedServerUrl() ?? deriveSameOriginServerUrl()),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({
    kind: "idle",
    error: initialError,
  });
  const initialUrl = useRef(serverUrl);
  const activeAttempt: { current: ConnectionAttempt | null } = useRef(null);
  const onConnected = useRef(onConnect);
  useEffect(() => {
    onConnected.current = onConnect;
  }, [onConnect]);

  const cancelAttempt = useCallback(() => {
    const attempt = activeAttempt.current;
    activeAttempt.current = null;
    if (!attempt) return;
    clearTimeout(attempt.timeout);
    attempt.controller.abort();
  }, []);

  // Ask the server what path it's serving, then connect. Single-click Connect flow.
  const connect = useCallback(
    async (url: string, selectedWorkspacePath?: string) => {
      cancelAttempt();
      const normalizedUrl = normalizeWebServerUrl(url);
      const controller = new AbortController();
      const { signal } = controller;
      const attempt: ConnectionAttempt = {
        controller,
        timeout: setTimeout(() => {
          controller.abort(
            new Error("Connection timed out. Check the server address and try again."),
          );
        }, 10_000),
      };
      activeAttempt.current = attempt;
      setConnection({ kind: "connecting", status: "Checking server…" });
      try {
        await probeWebSocket(normalizedUrl, signal);
        signal.throwIfAborted();

        let workspacePath = selectedWorkspacePath;
        if (workspacePath === undefined) {
          setConnection({ kind: "connecting", status: "Loading desktop state…" });
          const desktopService = await supportsDesktopService(normalizedUrl, signal);
          signal.throwIfAborted();
          if (desktopService) {
            workspacePath = "";
          } else {
            setConnection({ kind: "connecting", status: "Finding workspace…" });
            const workspaces = await fetchServerWorkspaces(normalizedUrl, signal);
            signal.throwIfAborted();
            if (workspaces.length === 0) {
              throw new Error(
                "Server is running but reports no workspace. Restart it with --dir <path>.",
              );
            }
            if (workspaces.length > 1) {
              setConnection({ kind: "choosing-workspace", serverUrl: normalizedUrl, workspaces });
              return;
            }
            workspacePath = workspaces[0].path;
          }
        }

        configureWebAdapter(normalizedUrl, workspacePath);
        window.cowork = createWebAdapter();
        setConnection({ kind: "idle", error: null });
        onConnected.current();
      } catch (err) {
        if (activeAttempt.current === attempt) {
          const failure = signal.aborted ? signal.reason : err;
          setConnection({
            kind: "idle",
            error: failure instanceof Error ? failure.message : String(failure),
          });
        }
      } finally {
        clearTimeout(attempt.timeout);
        if (activeAttempt.current === attempt) activeAttempt.current = null;
      }
    },
    [cancelAttempt],
  );

  useEffect(() => {
    void connect(initialUrl.current);
    return cancelAttempt;
  }, [cancelAttempt, connect]);

  const busy = connection.kind === "connecting";
  const status = connection.kind === "connecting" ? connection.status : null;
  const error = connection.kind === "idle" ? connection.error : null;

  const handleConnect = () => {
    void connect(serverUrl);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isImeComposing(e.nativeEvent) && !busy && serverUrl.trim()) {
      handleConnect();
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-[420px] rounded-xl border border-border bg-card p-8 shadow-sm">
        <h1 className="m-0 mb-1 text-xl font-semibold tracking-tight">Cowork</h1>
        <p className="mb-5 text-[13px] text-muted-foreground">Connect to a running Cowork server</p>

        {connection.kind === "choosing-workspace" ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">Select a workspace:</p>
            <div className="mb-4 flex flex-col gap-1">
              {connection.workspaces.map((ws) => (
                <Button
                  type="button"
                  key={ws.path}
                  variant="outline"
                  onClick={() => void connect(connection.serverUrl, ws.path)}
                  disabled={busy}
                  className="h-auto w-full flex-col items-start justify-start gap-0.5 px-3 py-2 text-left whitespace-normal"
                >
                  <span className="text-[13px] font-semibold text-foreground">{ws.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">{ws.path}</span>
                </Button>
              ))}
            </div>
          </>
        ) : null}

        <div className="mb-3 flex gap-2">
          <Button
            type="button"
            onClick={handleConnect}
            disabled={busy || !serverUrl.trim()}
            className="flex-1"
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                cancelAttempt();
                setConnection({ kind: "idle", error: null });
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>

        {status ? (
          <p role="status" aria-live="polite" className="mb-3 text-xs text-muted-foreground">
            {status}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mb-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          aria-expanded={showAdvanced}
          aria-controls="connect-advanced"
          onClick={() => setShowAdvanced((v) => !v)}
          className={`bg-transparent p-0 text-xs text-muted-foreground hover:text-foreground ${
            showAdvanced ? "mb-3" : ""
          }`}
        >
          {showAdvanced ? "Hide advanced" : "Advanced…"}
        </button>

        {showAdvanced ? (
          <div id="connect-advanced" className="flex flex-col gap-2">
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
              onChange={(e) => {
                cancelAttempt();
                setServerUrl(e.target.value);
                setConnection({ kind: "idle", error: null });
              }}
              onKeyDown={handleKeyDown}
              placeholder="ws://127.0.0.1:7337/ws"
            />
            <p className="m-0 text-xs text-muted-foreground">
              Defaults to same-origin via the Vite dev proxy. Override to point at a different
              Cowork server.
            </p>
          </div>
        ) : null}

        <p className="mt-4 mb-0 text-xs text-muted-foreground">
          Tip: <code className="text-xs">bun run desktop:web -- --dir /path/to/project</code>
        </p>
      </div>
    </div>
  );
}
