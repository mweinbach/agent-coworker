import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const coworkAlias = {
  "@cowork": path.resolve(repoRoot, "src"),
};
const defaultDesktopRendererPort = 1420;

function resolveDesktopRendererPort(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return defaultDesktopRendererPort;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return defaultDesktopRendererPort;
  }

  return parsed;
}

const desktopRendererPort = resolveDesktopRendererPort(process.env.COWORK_DESKTOP_RENDERER_PORT);
const safePublicTelemetryEnvKeys = [
  "COWORK_SENTRY_DSN",
  "COWORK_POSTHOG_KEY",
  "COWORK_POSTHOG_HOST",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "COWORK_DIAGNOSTICS_UPLOAD_URL",
  "COWORK_CLOUD_SYNC_ENDPOINT",
  "COWORK_DISABLE_NETWORK_TELEMETRY",
] as const;

function buildSafePublicTelemetryEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of safePublicTelemetryEnvKeys) {
    const value = process.env[key]?.trim();
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

const safePublicTelemetryDefine = {
  "globalThis.__COWORK_PUBLIC_TELEMETRY_ENV__": JSON.stringify(buildSafePublicTelemetryEnv()),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    future: "warn",
    define: safePublicTelemetryDefine,
    resolve: {
      alias: coworkAlias,
    },
    build: {
      sourcemap: false,
      reportCompressedSize: false,
      outDir: "out/main",
      rollupOptions: {
        input: path.resolve(appRoot, "electron/main.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    future: "warn",
    define: safePublicTelemetryDefine,
    resolve: {
      alias: coworkAlias,
    },
    build: {
      sourcemap: false,
      reportCompressedSize: false,
      // Sandboxed preloads cannot rely on arbitrary runtime requires from node_modules.
      // Bundle preload deps so the desktop bridge stays available at startup.
      externalizeDeps: false,
      outDir: "out/preload",
      rollupOptions: {
        input: path.resolve(appRoot, "electron/preload.ts"),
        output: {
          format: "cjs",
          entryFileNames: "preload.js",
        },
      },
    },
  },
  renderer: {
    root: appRoot,
    base: "./",
    plugins: [react(), tailwindcss()],
    future: "warn",
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: {
        "@": path.resolve(appRoot, "src"),
        ...coworkAlias,
      },
    },
    server: {
      port: desktopRendererPort,
      strictPort: true,
      fs: {
        allow: [repoRoot],
      },
    },
    build: {
      sourcemap: false,
      reportCompressedSize: false,
      outDir: "out/renderer",
      rollupOptions: {
        input: path.resolve(appRoot, "index.html"),
      },
    },
  },
});
