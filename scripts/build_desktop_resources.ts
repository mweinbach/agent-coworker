import fs from "node:fs/promises";
import path from "node:path";

import {
  buildSidecarManifest,
  resolvePackagedSidecarFilename,
} from "../apps/desktop/electron/services/sidecar";
import {
  buildLoomBridgeManifest,
  LOOM_BRIDGE_MANIFEST_NAME,
  resolvePackagedLoomBridgeFilename,
} from "../apps/desktop/electron/services/loomBridgeBinary";

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

async function removeExistingPackagedBinaryOutputs(dir: string, baseName: string) {
  const entries = await fs.readdir(dir).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry === baseName || entry.startsWith(`${baseName}-`))
      .map((entry) => fs.rm(path.join(dir, entry), { force: true }).catch(() => {}))
  );
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
  await rmrf(desktopBinariesDir);
  await fs.mkdir(desktopBinariesDir, { recursive: true });
  await removeExistingPackagedBinaryOutputs(desktopBinariesDir, "cowork-server");
  await removeExistingPackagedBinaryOutputs(desktopBinariesDir, "cowork-loom-bridge");

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

  if (process.platform === "darwin") {
    const loomPackagePath = path.join(root, "native", "CoworkLoomBridge");
    const loomBuildProc = Bun.spawn(
      [
        "swift",
        "build",
        "-c",
        "release",
        "--package-path",
        loomPackagePath,
        "--product",
        "cowork-loom-bridge",
      ],
      {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      }
    );
    const loomBuildCode = await loomBuildProc.exited;
    if (loomBuildCode !== 0) process.exit(loomBuildCode);

    const loomManifest = buildLoomBridgeManifest();
    const loomSourceBinary = path.join(loomPackagePath, ".build", "release", "cowork-loom-bridge");
    const loomOutfile = path.join(desktopBinariesDir, resolvePackagedLoomBridgeFilename());
    await fs.copyFile(loomSourceBinary, loomOutfile);
    await fs.writeFile(path.join(desktopBinariesDir, LOOM_BRIDGE_MANIFEST_NAME), `${JSON.stringify(loomManifest, null, 2)}\n`);
    await fs.chmod(loomOutfile, 0o755).catch(() => {});
    console.log(`[resources] built loom bridge sidecar at ${path.relative(root, loomOutfile)}`);
  } else {
    await fs.rm(path.join(desktopBinariesDir, LOOM_BRIDGE_MANIFEST_NAME), { force: true }).catch(() => {});
  }

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
