import fs from "node:fs/promises";
import path from "node:path";

import {
  buildSidecarManifest,
  resolvePackagedSidecarFilename,
} from "../apps/desktop/electron/services/sidecar";
import {
  rmrf,
  runBunBuild,
  stageBundledServerDist,
} from "./lib/serverBuild";

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const distDir = path.join(root, "dist");
  const serverOutDir = path.join(distDir, "server");

  await fs.mkdir(distDir, { recursive: true });
  await rmrf(serverOutDir);

  const entry = path.join(root, "src", "server", "index.ts");
  await runBunBuild({
    root,
    entry,
    outdir: serverOutDir,
    env: { ...process.env, COWORK_DESKTOP_BUNDLE: "1" },
    inlineEnvPatterns: ["COWORK_DESKTOP_BUNDLE*"],
  });

  // Build a standalone server sidecar so end users don't need Bun installed.
  // Electron packaging picks this up from apps/desktop/resources/binaries.
  const desktopBinariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  await rmrf(desktopBinariesDir);
  await fs.mkdir(desktopBinariesDir, { recursive: true });

  const manifest = buildSidecarManifest();
  const sidecarOutfile = path.join(desktopBinariesDir, resolvePackagedSidecarFilename());
  await fs.rm(sidecarOutfile, { force: true }).catch(() => {});
  await runBunBuild({
    root,
    entry,
    compile: true,
    outfile: sidecarOutfile,
    env: { ...process.env, COWORK_DESKTOP_BUNDLE: "1" },
    inlineEnvPatterns: ["COWORK_DESKTOP_BUNDLE*"],
    windowsHideConsole: process.platform === "win32",
  });

  await fs.writeFile(path.join(desktopBinariesDir, "cowork-server-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The desktop sidecar still needs built-in prompts/config under dist/{prompts,config}.
  // Curated skills are bootstrapped into ~/.cowork/skills on first desktop startup instead
  // of being bundled into the app resources.
  await stageBundledServerDist({
    root,
    distDir,
    includeDocs: true,
  });

  console.log(`[resources] built server bundle at ${path.relative(root, serverOutDir)}`);
  console.log(`[resources] built server sidecar at ${path.relative(root, sidecarOutfile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
