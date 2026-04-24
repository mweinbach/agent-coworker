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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    future: "warn",
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
