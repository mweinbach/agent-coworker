import fs from "node:fs/promises";
import path from "node:path";

import {
  buildSidecarManifest,
  resolvePackagedSidecarFilename,
} from "../apps/desktop/electron/services/sidecar";

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
  const includeDocs = process.env.COWORK_BUNDLE_DESKTOP_DOCS === "1";

  await fs.mkdir(distDir, { recursive: true });

  const entry = path.join(root, "src", "server", "index.ts");
  await rmrf(path.join(distDir, "server"));

  // Build a standalone server sidecar so end users don't need Bun installed.
  // Electron packaging picks this up from apps/desktop/resources/binaries.
  const desktopBinariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  await rmrf(desktopBinariesDir);
  await fs.mkdir(desktopBinariesDir, { recursive: true });

  const manifest = buildSidecarManifest();
  const sidecarOutfile = path.join(desktopBinariesDir, resolvePackagedSidecarFilename());
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

  await fs.writeFile(path.join(desktopBinariesDir, "cowork-server-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The desktop sidecar still needs built-in prompts/config under dist/{prompts,config}.
  // Curated skills are bootstrapped into ~/.cowork/skills on first desktop startup instead
  // of being bundled into the app resources.
  await rmrf(path.join(distDir, "skills"));
  for (const dir of ["prompts", "config"] as const) {
    const src = path.join(root, dir);
    const dest = path.join(distDir, dir);
    await rmrf(dest);
    await copyDir(src, dest);
  }

  const docsDest = path.join(distDir, "docs");
  await rmrf(docsDest);
  if (includeDocs) {
    const docsSrc = path.join(root, "docs");
    await copyDir(docsSrc, docsDest);
  }

  console.log("[resources] skipped dist/server desktop bundle (unused at runtime)");
  console.log(`[resources] bundled docs: ${includeDocs ? "enabled" : "disabled"}`);
  console.log(`[resources] built server sidecar at ${path.relative(root, sidecarOutfile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
