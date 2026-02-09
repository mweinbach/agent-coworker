import fs from "node:fs/promises";
import path from "node:path";

async function rmrf(p: string) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDir(src: string, dest: string) {
  // Bun supports fs.cp (Node 16+). Use it when available for performance.
  const anyFs = fs as any;
  if (typeof anyFs.cp === "function") {
    await anyFs.cp(src, dest, { recursive: true });
    return;
  }

  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyDir(from, to);
      continue;
    }
    if (e.isSymbolicLink()) continue;
    if (e.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const distDir = path.join(root, "dist");
  const serverOutDir = path.join(distDir, "server");

  await fs.mkdir(distDir, { recursive: true });
  await rmrf(serverOutDir);

  const entry = path.join(root, "src", "server", "index.ts");
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      entry,
      // Inline this env var into the bundle so provider modules can DCE
      // desktop-only branches (ex: gemini-cli provider depends on wasm assets
      // Bun's bundler currently can't resolve).
      "--env",
      "COWORK_DESKTOP_BUNDLE*",
      // These dependencies currently pull in wasm assets using `?binary` import
      // specifiers which Bun's bundler cannot resolve. They are unused in the
      // desktop bundle (provider is gated), so keep them external to unblock
      // building the server resources for Tauri.
      "--external",
      "ai-sdk-provider-gemini-cli",
      "--external",
      "@google/gemini-cli-core",
      "--outdir",
      serverOutDir,
      "--target",
      "bun",
      "--format",
      "esm",
    ],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, COWORK_DESKTOP_BUNDLE: "1" },
    }
  );
  const code = await proc.exited;
  if (code !== 0) process.exit(code);

  // The server expects built-in prompts/config/skills to live at builtInDir/{prompts,config,skills},
  // where builtInDir is the parent of dist/server/*.js (i.e. dist/).
  for (const dir of ["prompts", "config", "skills"] as const) {
    const src = path.join(root, dir);
    const dest = path.join(distDir, dir);
    await rmrf(dest);
    await copyDir(src, dest);
  }

  // Optional: include a copy of docs for UI builders.
  const docsSrc = path.join(root, "docs");
  const docsDest = path.join(distDir, "docs");
  await rmrf(docsDest);
  await copyDir(docsSrc, docsDest);

  console.log(`[resources] built server bundle at ${path.relative(root, serverOutDir)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
