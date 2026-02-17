import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: path.resolve(appRoot, "electron/main.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
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
    resolve: {
      alias: {
        "@cowork": path.resolve(repoRoot, "src"),
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
      outDir: "out/renderer",
      rollupOptions: {
        input: path.resolve(appRoot, "index.html"),
      },
    },
  },
});
