import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildSidecarManifest,
  SIDECAR_BUN_ENTRYPOINT_PATH,
  SIDECAR_BUN_EXECUTABLE_NAME,
  resolvePackagedSidecarFilename,
  shouldUseBundledBunRuntime,
} from "../apps/desktop/electron/services/sidecar";
import {
  copyDir,
  ensureBundledBunRuntime,
  pathExists,
  resolveBuildTarget,
  rmrf,
  runCommand,
} from "./releaseBuildUtils";

const CACHE_VERSION = 2;

type DesktopResourcesCache = {
  version: number;
  platform: NodeJS.Platform;
  arch: string;
  includeDocs: boolean;
  sidecarFingerprint: string;
  promptsFingerprint: string;
  configFingerprint: string;
  docsFingerprint: string | null;
};

async function walkForFingerprint(target: string, relativeTo: string, acc: string[]): Promise<void> {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      await walkForFingerprint(path.join(target, entry.name), relativeTo, acc);
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  const relative = path.relative(relativeTo, target);
  acc.push(`${relative}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
}

async function fingerprintInputs(targets: string[], root: string): Promise<string> {
  const acc: string[] = [];
  for (const target of targets) {
    if (!(await pathExists(target))) {
      acc.push(`${path.relative(root, target)}:missing`);
      continue;
    }
    await walkForFingerprint(target, root, acc);
  }
  const hash = createHash("sha256");
  hash.update(acc.join("\n"));
  return hash.digest("hex");
}

async function loadCache(cachePath: string): Promise<DesktopResourcesCache | null> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopResourcesCache>;
    if (
      parsed.version !== CACHE_VERSION
      || typeof parsed.platform !== "string"
      || parsed.platform.length === 0
      || typeof parsed.arch !== "string"
      || parsed.arch.length === 0
      || typeof parsed.includeDocs !== "boolean"
      || typeof parsed.sidecarFingerprint !== "string"
      || typeof parsed.promptsFingerprint !== "string"
      || typeof parsed.configFingerprint !== "string"
      || (parsed.docsFingerprint !== null && typeof parsed.docsFingerprint !== "string")
    ) {
      return null;
    }
    return parsed as DesktopResourcesCache;
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: DesktopResourcesCache): Promise<void> {
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function syncCopiedDir(opts: {
  label: string;
  src: string;
  dest: string;
  previousFingerprint: string | null;
  nextFingerprint: string;
}): Promise<void> {
  const needsCopy =
    opts.previousFingerprint !== opts.nextFingerprint
    || !(await pathExists(opts.dest));
  if (!needsCopy) {
    console.log(`[resources] ${opts.label}: cached`);
    return;
  }

  await rmrf(opts.dest);
  await copyDir(opts.src, opts.dest);
  console.log(`[resources] ${opts.label}: updated`);
}

async function main() {
  const target = resolveBuildTarget(process.argv.slice(2));
  const { platform, arch } = target;
  const root = path.resolve(import.meta.dirname, "..");
  const distDir = path.join(root, "dist");
  const includeDocs = process.env.COWORK_BUNDLE_DESKTOP_DOCS === "1";
  const cachePath = path.join(distDir, `.desktop-resources-cache-${platform}-${arch}.json`);

  await fs.mkdir(distDir, { recursive: true });
  await rmrf(path.join(distDir, "server"));

  const cache = await loadCache(cachePath);

  const sidecarInputs = [
    path.join(root, "src"),
    path.join(root, "config"),
    path.join(root, "prompts"),
    path.join(root, "apps", "desktop", "electron", "services", "sidecar.ts"),
    path.join(root, "scripts", "build_desktop_resources.ts"),
    path.join(root, "scripts", "releaseBuildUtils.ts"),
    path.join(root, "package.json"),
    path.join(root, "bun.lock"),
    path.join(root, "tsconfig.json"),
  ];
  const promptsSrc = path.join(root, "prompts");
  const configSrc = path.join(root, "config");
  const docsSrc = path.join(root, "docs");
  const promptsFingerprint = await fingerprintInputs([promptsSrc], root);
  const configFingerprint = await fingerprintInputs([configSrc], root);
  const docsFingerprint = includeDocs ? await fingerprintInputs([docsSrc], root) : null;
  const sidecarFingerprint = await fingerprintInputs(sidecarInputs, root);

  const desktopBinariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  const sidecarOutfile = path.join(desktopBinariesDir, resolvePackagedSidecarFilename(platform, arch));
  const sidecarManifestPath = path.join(desktopBinariesDir, "cowork-server-manifest.json");
  const bundledBunPath = path.join(desktopBinariesDir, SIDECAR_BUN_EXECUTABLE_NAME);
  const bundledEntrypointPath = path.join(desktopBinariesDir, SIDECAR_BUN_ENTRYPOINT_PATH);
  const useBundledBunRuntime = shouldUseBundledBunRuntime(platform, arch);
  const sidecarNeedsBuild =
    cache?.platform !== platform
    || cache?.arch !== arch
    || cache?.includeDocs !== includeDocs
    || cache?.sidecarFingerprint !== sidecarFingerprint
    || !(await pathExists(sidecarManifestPath))
    || (useBundledBunRuntime
      ? !(await pathExists(bundledBunPath)) || !(await pathExists(bundledEntrypointPath))
      : !(await pathExists(sidecarOutfile)));

  if (sidecarNeedsBuild) {
    const entry = path.join(root, "src", "server", "index.ts");
    await rmrf(desktopBinariesDir);
    await fs.mkdir(desktopBinariesDir, { recursive: true });

    const manifest = buildSidecarManifest(platform, arch);
    if (useBundledBunRuntime) {
      const bundledEntrypointDir = path.dirname(bundledEntrypointPath);
      await fs.mkdir(bundledEntrypointDir, { recursive: true });
      await runCommand(
        [
          "bun",
          "build",
          entry,
          "--outfile",
          bundledEntrypointPath,
          "--env",
          "COWORK_DESKTOP_BUNDLE*",
          "--target",
          "bun",
        ],
        {
          cwd: root,
          env: { ...process.env, COWORK_DESKTOP_BUNDLE: "1" },
        }
      );

      const { executablePath, version } = await ensureBundledBunRuntime(root, target);
      await fs.copyFile(executablePath, bundledBunPath);
      console.log(
        `[resources] sidecar: rebuilt ${path.relative(root, bundledEntrypointPath)} with Bun runtime v${version}`
      );
    } else {
      if (platform !== process.platform || arch !== process.arch) {
        throw new Error(
          `Cross-compiling desktop sidecars is unsupported for ${platform}/${arch} on ${process.platform}/${process.arch}`
        );
      }

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
      if (process.platform === "win32") {
        compileArgs.push("--windows-hide-console");
      }

      await runCommand(compileArgs, {
        cwd: root,
        env: { ...process.env, COWORK_DESKTOP_BUNDLE: "1" },
      });
      console.log(`[resources] sidecar: rebuilt ${path.relative(root, sidecarOutfile)}`);
    }

    await fs.writeFile(sidecarManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log("[resources] sidecar: cached");
  }

  const promptsDest = path.join(distDir, "prompts");
  const configDest = path.join(distDir, "config");
  await rmrf(path.join(distDir, "skills"));

  await syncCopiedDir({
    label: "prompts",
    src: promptsSrc,
    dest: promptsDest,
    previousFingerprint: cache?.promptsFingerprint ?? null,
    nextFingerprint: promptsFingerprint,
  });

  await syncCopiedDir({
    label: "config",
    src: configSrc,
    dest: configDest,
    previousFingerprint: cache?.configFingerprint ?? null,
    nextFingerprint: configFingerprint,
  });

  const docsDest = path.join(distDir, "docs");
  if (!includeDocs) {
    await rmrf(docsDest);
    console.log("[resources] docs: disabled");
  } else {
    await syncCopiedDir({
      label: "docs",
      src: docsSrc,
      dest: docsDest,
      previousFingerprint: cache?.docsFingerprint ?? null,
      nextFingerprint: docsFingerprint!,
    });
  }

  await writeCache(cachePath, {
    version: CACHE_VERSION,
    platform,
    arch,
    includeDocs,
    sidecarFingerprint,
    promptsFingerprint,
    configFingerprint,
    docsFingerprint,
  });

  console.log("[resources] skipped dist/server desktop bundle (unused at runtime)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
