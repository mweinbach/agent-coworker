import fs from "node:fs/promises";
import path from "node:path";

import {
  buildServerBinaryManifest,
  resolveServerBinaryFilename,
  resolveServerTargetTriple,
  SERVER_BINARY_MANIFEST_NAME,
} from "../src/server/binaryArtifact";
import {
  rmrf,
  runBunBuild,
  stageBundledServerDist,
} from "./lib/serverBuild";

function printUsage(): void {
  console.log("Usage: bun scripts/build_server_binary.ts [--outdir <directory>]");
}

function parseArgs(argv: string[]): { outdir?: string } {
  let outdir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--outdir") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --outdir");
      }
      outdir = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { outdir };
}

async function main(): Promise<void> {
  const { outdir } = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "..");
  const targetTriple = resolveServerTargetTriple();
  const releaseDir = path.resolve(root, outdir ?? path.join("release", `cowork-server-${targetTriple}`));
  const binaryFilename = resolveServerBinaryFilename({ includeTargetTriple: false });
  const binaryPath = path.join(releaseDir, binaryFilename);
  const builtInDir = path.join(releaseDir, "dist");

  await rmrf(releaseDir);
  await fs.mkdir(releaseDir, { recursive: true });

  await runBunBuild({
    root,
    entry: path.join(root, "src", "server", "index.ts"),
    compile: true,
    outfile: binaryPath,
    env: process.env,
  });

  await stageBundledServerDist({
    root,
    distDir: builtInDir,
    includeDocs: true,
  });

  const manifest = buildServerBinaryManifest({ includeTargetTriple: false });
  await fs.writeFile(
    path.join(releaseDir, SERVER_BINARY_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(`[server-binary] built ${targetTriple} bundle at ${path.relative(root, releaseDir)}`);
  console.log(`[server-binary] binary: ${path.relative(root, binaryPath)}`);
  console.log(`[server-binary] builtin dir: ${path.relative(root, builtInDir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
