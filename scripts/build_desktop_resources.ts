import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildSidecarManifest,
  FOUNDATION_MODELS_KOFFI_TRIPLET,
  FOUNDATION_MODELS_SDK_DIR_NAME,
  resolvePackagedCodexAppServerFilename,
  resolvePackagedSidecarFilename,
  SIDECAR_BUN_ENTRYPOINT_PATH,
  SIDECAR_BUN_EXECUTABLE_NAME,
  shouldBundleFoundationModelsSdk,
  shouldUseBundledBunRuntime,
} from "../apps/desktop/electron/services/sidecar";
import {
  copyDir,
  ensureBundledBunRuntime,
  ensureBundledCodexAppServer,
  pathExists,
  resolveBuildTarget,
  rmrf,
  runCommand,
} from "./releaseBuildUtils";

const CACHE_VERSION = 4;

type DesktopResourcesCache = {
  version: number;
  platform: NodeJS.Platform;
  arch: string;
  includeDocs: boolean;
  sidecarFingerprint: string;
  codexAppServerVersion: string | null;
  promptsFingerprint: string;
  configFingerprint: string;
  skillsFingerprint: string;
  codexPrimaryRuntimeFingerprint: string | null;
  foundationModelsSdkFingerprint: string | null;
  docsFingerprint: string | null;
};

async function walkForFingerprint(
  target: string,
  relativeTo: string,
  acc: string[],
): Promise<void> {
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
      parsed.version !== CACHE_VERSION ||
      typeof parsed.platform !== "string" ||
      parsed.platform.length === 0 ||
      typeof parsed.arch !== "string" ||
      parsed.arch.length === 0 ||
      typeof parsed.includeDocs !== "boolean" ||
      typeof parsed.sidecarFingerprint !== "string" ||
      (parsed.codexAppServerVersion !== null && typeof parsed.codexAppServerVersion !== "string") ||
      typeof parsed.promptsFingerprint !== "string" ||
      typeof parsed.configFingerprint !== "string" ||
      typeof parsed.skillsFingerprint !== "string" ||
      (parsed.codexPrimaryRuntimeFingerprint !== null &&
        typeof parsed.codexPrimaryRuntimeFingerprint !== "string") ||
      (parsed.foundationModelsSdkFingerprint !== null &&
        typeof parsed.foundationModelsSdkFingerprint !== "string") ||
      (parsed.docsFingerprint !== null && typeof parsed.docsFingerprint !== "string")
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

function normalizeCodexAppServerVersionOverride(version: string | undefined): string | null {
  if (!version) {
    return null;
  }
  return version.startsWith("rust-v") ? version.slice("rust-v".length) : version;
}

async function resolveCodexPrimaryRuntimeSource(): Promise<string | null> {
  const fromEnv = process.env.COWORK_CODEX_PRIMARY_RUNTIME_DIR?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!(await pathExists(path.join(resolved, "runtime.json")))) {
      throw new Error(
        `COWORK_CODEX_PRIMARY_RUNTIME_DIR does not contain runtime.json: ${resolved}`,
      );
    }
    return resolved;
  }

  const defaultRuntimeDir = path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
  );
  if (await pathExists(path.join(defaultRuntimeDir, "runtime.json"))) {
    return defaultRuntimeDir;
  }

  return null;
}

async function syncCopiedDir(opts: {
  label: string;
  src: string;
  dest: string;
  previousFingerprint: string | null;
  nextFingerprint: string;
}): Promise<void> {
  const needsCopy =
    opts.previousFingerprint !== opts.nextFingerprint || !(await pathExists(opts.dest));
  if (!needsCopy) {
    console.log(`[resources] ${opts.label}: cached`);
    return;
  }

  await rmrf(opts.dest);
  await copyDir(opts.src, opts.dest);
  console.log(`[resources] ${opts.label}: updated`);
}

async function ensureFoundationModelsSdkInputs(root: string): Promise<{
  sdkRoot: string;
  koffiRoot: string;
  fingerprintTargets: string[];
}> {
  const sdkRoot = path.join(root, "node_modules", "tsfm-sdk");
  const koffiRoot = path.join(root, "node_modules", "koffi");
  const requiredFiles = [
    path.join(sdkRoot, "package.json"),
    path.join(sdkRoot, "dist", "index.js"),
    path.join(sdkRoot, "native", "libFoundationModels.dylib"),
    path.join(koffiRoot, "index.js"),
    path.join(koffiRoot, "package.json"),
    path.join(koffiRoot, "build", "koffi", FOUNDATION_MODELS_KOFFI_TRIPLET, "koffi.node"),
  ];

  for (const requiredFile of requiredFiles) {
    if (!(await pathExists(requiredFile))) {
      throw new Error(
        `Apple Foundation Models title support requires optional tsfm-sdk resources for macOS arm64 packaging, but this file is missing: ${requiredFile}. Run bun install on an Apple Silicon Mac first.`,
      );
    }
  }

  return {
    sdkRoot,
    koffiRoot,
    fingerprintTargets: [
      path.join(sdkRoot, "package.json"),
      path.join(sdkRoot, "dist"),
      path.join(sdkRoot, "native", "libFoundationModels.dylib"),
      path.join(koffiRoot, "index.js"),
      path.join(koffiRoot, "package.json"),
      path.join(koffiRoot, "build", "koffi", FOUNDATION_MODELS_KOFFI_TRIPLET, "koffi.node"),
    ],
  };
}

async function copyIfExists(src: string, dest: string): Promise<void> {
  if (!(await pathExists(src))) {
    return;
  }
  await fs.copyFile(src, dest);
}

async function syncFoundationModelsSdk(opts: {
  root: string;
  dest: string;
  previousFingerprint: string | null;
  nextFingerprint: string | null;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<void> {
  if (!shouldBundleFoundationModelsSdk(opts.platform, opts.arch)) {
    await rmrf(opts.dest);
    console.log("[resources] Foundation Models SDK: disabled");
    return;
  }

  const inputs = await ensureFoundationModelsSdkInputs(opts.root);
  const currentLooksComplete =
    (await pathExists(path.join(opts.dest, "dist", "index.js"))) &&
    (await pathExists(path.join(opts.dest, "native", "libFoundationModels.dylib"))) &&
    (await pathExists(
      path.join(
        opts.dest,
        "node_modules",
        "koffi",
        "build",
        "koffi",
        FOUNDATION_MODELS_KOFFI_TRIPLET,
        "koffi.node",
      ),
    ));
  if (opts.previousFingerprint === opts.nextFingerprint && currentLooksComplete) {
    console.log("[resources] Foundation Models SDK: cached");
    return;
  }

  await rmrf(opts.dest);
  await fs.mkdir(opts.dest, { recursive: true });
  await copyDir(path.join(inputs.sdkRoot, "dist"), path.join(opts.dest, "dist"));
  await fs.mkdir(path.join(opts.dest, "native"), { recursive: true });
  await fs.copyFile(
    path.join(inputs.sdkRoot, "native", "libFoundationModels.dylib"),
    path.join(opts.dest, "native", "libFoundationModels.dylib"),
  );
  await copyIfExists(
    path.join(inputs.sdkRoot, "package.json"),
    path.join(opts.dest, "package.json"),
  );
  await copyIfExists(path.join(inputs.sdkRoot, "LICENSE.md"), path.join(opts.dest, "LICENSE.md"));
  await copyIfExists(path.join(inputs.sdkRoot, "NOTICE"), path.join(opts.dest, "NOTICE"));

  const koffiDest = path.join(opts.dest, "node_modules", "koffi");
  await fs.mkdir(path.join(koffiDest, "build", "koffi", FOUNDATION_MODELS_KOFFI_TRIPLET), {
    recursive: true,
  });
  await fs.copyFile(path.join(inputs.koffiRoot, "index.js"), path.join(koffiDest, "index.js"));
  await fs.copyFile(
    path.join(inputs.koffiRoot, "package.json"),
    path.join(koffiDest, "package.json"),
  );
  await fs.copyFile(
    path.join(inputs.koffiRoot, "build", "koffi", FOUNDATION_MODELS_KOFFI_TRIPLET, "koffi.node"),
    path.join(koffiDest, "build", "koffi", FOUNDATION_MODELS_KOFFI_TRIPLET, "koffi.node"),
  );
  console.log("[resources] Foundation Models SDK: updated");
}

async function main() {
  const target = resolveBuildTarget(process.argv.slice(2));
  const { platform, arch } = target;
  const root = path.resolve(import.meta.dirname, "..");
  const distDir = path.join(root, "dist");
  const includeDocs = process.env.COWORK_BUNDLE_DESKTOP_DOCS === "1";
  const shouldBundleCodexPrimaryRuntime = process.env.COWORK_BUNDLE_CODEX_PRIMARY_RUNTIME === "1";
  const codexAppServerVersionOverride =
    process.env.COWORK_CODEX_APP_SERVER_VERSION?.trim() || undefined;
  const shouldBundleCodexAppServer = process.env.COWORK_BUNDLE_CODEX_APP_SERVER === "1";
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
  const skillsSrc = path.join(root, "skills");
  const docsSrc = path.join(root, "docs");
  const codexPrimaryRuntimeSource = shouldBundleCodexPrimaryRuntime
    ? await resolveCodexPrimaryRuntimeSource()
    : null;
  if (shouldBundleCodexPrimaryRuntime && !codexPrimaryRuntimeSource) {
    throw new Error(
      "COWORK_BUNDLE_CODEX_PRIMARY_RUNTIME=1 but no Codex primary runtime cache was found. Set COWORK_CODEX_PRIMARY_RUNTIME_DIR or run the Codex runtime setup first.",
    );
  }
  const promptsFingerprint = await fingerprintInputs([promptsSrc], root);
  const configFingerprint = await fingerprintInputs([configSrc], root);
  const skillsFingerprint = await fingerprintInputs([skillsSrc], root);
  const codexPrimaryRuntimeFingerprint = codexPrimaryRuntimeSource
    ? await fingerprintInputs([codexPrimaryRuntimeSource], codexPrimaryRuntimeSource)
    : null;
  const foundationModelsSdkInputs = shouldBundleFoundationModelsSdk(platform, arch)
    ? await ensureFoundationModelsSdkInputs(root)
    : null;
  const foundationModelsSdkFingerprint = foundationModelsSdkInputs
    ? await fingerprintInputs(foundationModelsSdkInputs.fingerprintTargets, root)
    : null;
  const docsFingerprint = includeDocs ? await fingerprintInputs([docsSrc], root) : null;
  const sidecarFingerprint = await fingerprintInputs(sidecarInputs, root);

  const desktopBinariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  const sidecarOutfile = path.join(
    desktopBinariesDir,
    resolvePackagedSidecarFilename(platform, arch),
  );
  const codexAppServerFilename = resolvePackagedCodexAppServerFilename(platform, arch);
  const codexAppServerOutfile = path.join(desktopBinariesDir, codexAppServerFilename);
  const sidecarManifestPath = path.join(desktopBinariesDir, "cowork-server-manifest.json");
  const foundationModelsSdkDest = path.join(desktopBinariesDir, FOUNDATION_MODELS_SDK_DIR_NAME);
  const bundledBunPath = path.join(desktopBinariesDir, SIDECAR_BUN_EXECUTABLE_NAME);
  const bundledEntrypointPath = path.join(desktopBinariesDir, SIDECAR_BUN_ENTRYPOINT_PATH);
  const useBundledBunRuntime = shouldUseBundledBunRuntime(platform, arch);
  const sidecarNeedsBuild =
    cache?.platform !== platform ||
    cache?.arch !== arch ||
    cache?.includeDocs !== includeDocs ||
    cache?.sidecarFingerprint !== sidecarFingerprint ||
    !(await pathExists(sidecarManifestPath)) ||
    (shouldBundleCodexAppServer && !(await pathExists(codexAppServerOutfile))) ||
    (useBundledBunRuntime
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
          "--minify",
          "--sourcemap=none",
        ],
        {
          cwd: root,
          env: { ...process.env, COWORK_DESKTOP_BUNDLE: "1" },
        },
      );

      const { executablePath, version } = await ensureBundledBunRuntime(root, target);
      await fs.copyFile(executablePath, bundledBunPath);
      console.log(
        `[resources] sidecar: rebuilt ${path.relative(root, bundledEntrypointPath)} with Bun runtime v${version}`,
      );
    } else {
      if (platform !== process.platform || arch !== process.arch) {
        throw new Error(
          `Cross-compiling desktop sidecars is unsupported for ${platform}/${arch} on ${process.platform}/${process.arch}`,
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
        "--minify",
        "--sourcemap=none",
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

  let codexAppServerVersion: string | null = cache?.codexAppServerVersion ?? null;
  if (shouldBundleCodexAppServer) {
    const pinnedVersion = normalizeCodexAppServerVersionOverride(codexAppServerVersionOverride);
    const cachedVersionMatches =
      cache?.platform === platform &&
      cache?.arch === arch &&
      cache?.codexAppServerVersion &&
      (pinnedVersion === null || cache.codexAppServerVersion === pinnedVersion);
    if (cachedVersionMatches && (await pathExists(codexAppServerOutfile))) {
      codexAppServerVersion = cache.codexAppServerVersion;
      console.log(`[resources] codex app-server: cached v${codexAppServerVersion}`);
    } else {
      const codexBundle = await ensureBundledCodexAppServer(root, target, {
        version: codexAppServerVersionOverride,
        outputName: codexAppServerFilename,
      });
      codexAppServerVersion = codexBundle.version;
      await fs.copyFile(codexBundle.executablePath, codexAppServerOutfile);
      if (platform !== "win32") {
        await fs.chmod(codexAppServerOutfile, 0o755);
      }
      console.log(
        `[resources] codex app-server: bundled ${codexBundle.assetName} v${codexBundle.version}`,
      );
    }
  } else {
    await fs.rm(codexAppServerOutfile, { force: true });
    codexAppServerVersion = null;
    console.log("[resources] codex app-server: disabled");
  }

  const promptsDest = path.join(distDir, "prompts");
  const configDest = path.join(distDir, "config");
  const skillsDest = path.join(distDir, "skills");
  const codexPrimaryRuntimeDest = path.join(distDir, "codex-primary-runtime");

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

  await syncCopiedDir({
    label: "skills",
    src: skillsSrc,
    dest: skillsDest,
    previousFingerprint: cache?.skillsFingerprint ?? null,
    nextFingerprint: skillsFingerprint,
  });

  if (codexPrimaryRuntimeSource && codexPrimaryRuntimeFingerprint) {
    await syncCopiedDir({
      label: "codex primary runtime",
      src: codexPrimaryRuntimeSource,
      dest: codexPrimaryRuntimeDest,
      previousFingerprint: cache?.codexPrimaryRuntimeFingerprint ?? null,
      nextFingerprint: codexPrimaryRuntimeFingerprint,
    });
  } else {
    await rmrf(codexPrimaryRuntimeDest);
    await fs.mkdir(codexPrimaryRuntimeDest, { recursive: true });
    console.log("[resources] codex primary runtime: disabled");
  }

  await syncFoundationModelsSdk({
    root,
    dest: foundationModelsSdkDest,
    previousFingerprint: cache?.foundationModelsSdkFingerprint ?? null,
    nextFingerprint: foundationModelsSdkFingerprint,
    platform,
    arch,
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
    codexAppServerVersion,
    promptsFingerprint,
    configFingerprint,
    skillsFingerprint,
    codexPrimaryRuntimeFingerprint,
    foundationModelsSdkFingerprint,
    docsFingerprint,
  });

  console.log("[resources] skipped dist/server desktop bundle (unused at runtime)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
