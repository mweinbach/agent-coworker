import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");

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
      },
    },
  },
  renderer: {
    root: appRoot,
    base: "./",
    plugins: [react()],
    resolve: {
      alias: {
        "@cowork": path.resolve(repoRoot, "src"),
      },
    },
    server: {
      port: 1420,
      strictPort: false,
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
