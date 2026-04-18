import React, { useCallback, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { ConnectPage } from "./components/ConnectPage";
import { configureWebAdapter, createWebAdapter } from "./lib/webAdapter";
import "./styles.css";

// Hoisted to module scope so it isn't re-created on each render.
const App = React.lazy(() => import("./App"));

function readQueryConnect(): { server: string; dir: string } | null {
  const params = new URLSearchParams(window.location.search);
  const server = params.get("server");
  if (!server) return null;
  return { server, dir: params.get("dir")?.trim() ?? "" };
}

function WebEntry() {
  const initialError = useRef<string | null>(null);

  const [connected, setConnected] = useState(() => {
    const q = readQueryConnect();
    if (!q || !q.dir) return false;
    try {
      configureWebAdapter(q.server, q.dir);
      window.cowork = createWebAdapter();
      return true;
    } catch (err) {
      initialError.current = err instanceof Error ? err.message : String(err);
      return false;
    }
  });

  const handleConnect = useCallback(() => {
    setConnected(true);
  }, []);

  if (!connected) {
    return (
      <ConnectPage
        onConnect={handleConnect}
        initialError={initialError.current}
        initialServerUrl={readQueryConnect()?.server ?? null}
      />
    );
  }

  return (
    <React.Suspense
      fallback={<div style={{ height: "100vh", background: "var(--surface-window)" }} />}
    >
      <App />
    </React.Suspense>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WebEntry />
  </React.StrictMode>,
);
