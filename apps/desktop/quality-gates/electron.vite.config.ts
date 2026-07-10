import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const qualityGateRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(qualityGateRoot, "..");
const repoRoot = path.resolve(appRoot, "../..");
const coworkAlias = {
  "@cowork": path.resolve(repoRoot, "src"),
};

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
      outDir: path.resolve(appRoot, "out-quality/main"),
      rollupOptions: {
        input: {
          qualityGateMain: path.resolve(appRoot, "electron/qualityGateMain.ts"),
        },
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
      externalizeDeps: false,
      outDir: path.resolve(appRoot, "out-quality/preload"),
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
    root: qualityGateRoot,
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
      fs: {
        allow: [repoRoot],
      },
    },
    build: {
      sourcemap: false,
      reportCompressedSize: false,
      outDir: path.resolve(appRoot, "out-quality/renderer"),
      rollupOptions: {
        input: path.resolve(qualityGateRoot, "index.html"),
      },
    },
  },
});
