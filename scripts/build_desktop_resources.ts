import fs from "node:fs/promises";
import path from "node:path";

async function rmrf(p: string) {
  await fs.rm(p, { recursive: true, force: true });
}

function resolveDesktopTargetTriple(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }

  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }

  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
  }

  throw new Error(`Unsupported platform/arch for desktop sidecar: ${platform}/${arch}`);
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
      // desktop-only branches.
      "--env",
      "COWORK_DESKTOP_BUNDLE*",
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

  // Build a standalone server sidecar so end users don't need Bun installed.
  // Electron packaging picks this up from apps/desktop/resources/binaries.
  const desktopBinariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  await fs.mkdir(desktopBinariesDir, { recursive: true });

  const targetTriple = resolveDesktopTargetTriple();
  const sidecarBaseName = "cowork-server";
  const sidecarExt = process.platform === "win32" ? ".exe" : "";
  const sidecarOutfile = path.join(desktopBinariesDir, `${sidecarBaseName}-${targetTriple}${sidecarExt}`);
  await fs.rm(sidecarOutfile, { force: true }).catch(() => {});

  const compileArgs = [
    "bun",
    "build",
    entry,
    "--compile",
    "--outfile",
    sidecarOutfile,
    "--env",
    "COWORK_DESKTOP_BUNDLE*",
    "--target",
    "bun",
  ];
  if (process.platform === "win32") compileArgs.push("--windows-hide-console");

  const sidecarProc = Bun.spawn(compileArgs, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, COWORK_DESKTOP_BUNDLE: "1" },
  });
  const sidecarCode = await sidecarProc.exited;
  if (sidecarCode !== 0) process.exit(sidecarCode);

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
  console.log(`[resources] built server sidecar at ${path.relative(root, sidecarOutfile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
