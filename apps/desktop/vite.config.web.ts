import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");

const defaultWebDevPort = 8281;
const defaultHttpServerTarget = "http://127.0.0.1:7337";
const defaultWsServerTarget = "ws://127.0.0.1:7337";

function resolveWebDevPort(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return defaultWebDevPort;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return defaultWebDevPort;
  }
  return parsed;
}

function resolveHttpServerTarget(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return defaultHttpServerTarget;
  try {
    const parsed = new URL(trimmed);
    const proto =
      parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    return `${proto}//${parsed.host}`;
  } catch {
    return defaultHttpServerTarget;
  }
}

function resolveWsServerTarget(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return defaultWsServerTarget;
  try {
    const parsed = new URL(trimmed);
    const proto =
      parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
    return `${proto}//${parsed.host}`;
  } catch {
    return defaultWsServerTarget;
  }
}

const webDevPort = resolveWebDevPort(process.env.COWORK_WEB_DEV_PORT);
const httpServerTarget = resolveHttpServerTarget(process.env.COWORK_SERVER_URL);
const wsServerTarget = resolveWsServerTarget(process.env.COWORK_SERVER_URL);
const injectedServerUrl = process.env.COWORK_SERVER_URL?.trim() || "";

export default defineConfig({
  root: appRoot,
  define: {
    "globalThis.__COWORK_SERVER_URL__": JSON.stringify(injectedServerUrl),
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "cowork-web-entry",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (!req.url) {
            next();
            return;
          }
          const [pathname, search = ""] = req.url.split("?");
          if (pathname === "/" || pathname === "/index.html") {
            req.url = `/index.web.html${search ? `?${search}` : ""}`;
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(appRoot, "src"),
      "@cowork": path.resolve(repoRoot, "src"),
    },
  },
  server: {
    port: webDevPort,
    strictPort: false,
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      "/cowork/ws": {
        target: wsServerTarget,
        ws: true,
        changeOrigin: true,
        rewrite: () => "/ws",
      },
      "/cowork": {
        target: httpServerTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: false,
    reportCompressedSize: false,
    outDir: "out/web",
    rollupOptions: {
      input: path.resolve(appRoot, "index.web.html"),
    },
  },
});
