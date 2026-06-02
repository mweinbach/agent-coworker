import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildSidecarManifest,
  FOUNDATION_MODELS_KOFFI_TRIPLET,
  FOUNDATION_MODELS_SDK_DIR_NAME,
  resolvePackagedSidecarFilename,
  resolveWindowsAiElectronPrebuildTriplet,
  SIDECAR_BUN_ENTRYPOINT_PATH,
  SIDECAR_BUN_EXECUTABLE_NAME,
  shouldBundleFoundationModelsSdk,
  shouldBundleWindowsAiElectronPackage,
  shouldUseBundledBunRuntime,
  WINDOWS_AI_ELECTRON_DIR_NAME,
} from "../apps/desktop/electron/services/sidecar";
import {
  buildBunBundle,
  copyDir,
  ensureBundledBunRuntime,
  pathExists,
  resolveBuildTarget,
  resolveBundledBunRuntimeVersion,
  rmrf,
  runCommand,
} from "./releaseBuildUtils";

const CACHE_VERSION = 8;
const MANAGED_SOFFICE_HELPER_RELATIVE_PATH = path.join("assets", "managed-soffice-helper.mjs");

type DesktopResourcesCache = {
  version: number;
  platform: NodeJS.Platform;
  arch: string;
  includeDocs: boolean;
  sidecarFingerprint: string;
  promptsFingerprint: string;
  configFingerprint: string;
  skillsFingerprint: string;
  codexPrimaryRuntimeFingerprint: string | null;
  artifactRuntimeFingerprint: string | null;
  foundationModelsSdkFingerprint: string | null;
  windowsAiElectronFingerprint: string | null;
  docsFingerprint: string | null;
  bundledBunRuntimeVersion: string | null;
};

async function walkForFingerprint(
  target: string,
  relativeTo: string,
  acc: string[],
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      acc.push(`${path.relative(relativeTo, target)}:missing`);
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    acc.push(`${path.relative(relativeTo, target)}:symlink:${stat.size}`);
    return;
  }
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
      typeof parsed.promptsFingerprint !== "string" ||
      typeof parsed.configFingerprint !== "string" ||
      typeof parsed.skillsFingerprint !== "string" ||
      (parsed.codexPrimaryRuntimeFingerprint !== null &&
        typeof parsed.codexPrimaryRuntimeFingerprint !== "string") ||
      (parsed.artifactRuntimeFingerprint !== null &&
        typeof parsed.artifactRuntimeFingerprint !== "string") ||
      (parsed.foundationModelsSdkFingerprint !== null &&
        typeof parsed.foundationModelsSdkFingerprint !== "string") ||
      (parsed.windowsAiElectronFingerprint !== null &&
        typeof parsed.windowsAiElectronFingerprint !== "string") ||
      (parsed.docsFingerprint !== null && typeof parsed.docsFingerprint !== "string") ||
      (parsed.bundledBunRuntimeVersion !== null &&
        typeof parsed.bundledBunRuntimeVersion !== "string")
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

async function removeLegacyCodexAppServerBinaries(desktopBinariesDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(desktopBinariesDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith("codex-app-server"))
      .map(async (entry) => {
        await fs.rm(path.join(desktopBinariesDir, entry), { force: true });
      }),
  );
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

async function resolveArtifactRuntimeSource(): Promise<string | null> {
  const fromEnv = process.env.COWORK_ARTIFACT_RUNTIME_DIR?.trim();
  const isUsable = async (dir: string): Promise<boolean> =>
    (await pathExists(path.join(dir, "runtime.json"))) ||
    (await pathExists(path.join(dir, "node", "node_modules", "@oai", "artifact-tool")));

  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!(await isUsable(resolved))) {
      throw new Error(
        `COWORK_ARTIFACT_RUNTIME_DIR does not contain an artifact runtime tree: ${resolved}`,
      );
    }
    return resolved;
  }

  const defaultRuntimeDir = path.join(os.homedir(), ".cache", "cowork", "artifact-runtime");
  return (await isUsable(defaultRuntimeDir)) ? defaultRuntimeDir : null;
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

async function ensureWindowsAiElectronInputs(
  root: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<{
  packageRoot: string;
  prebuildTriplet: string;
  fingerprintTargets: string[];
} | null> {
  const packageRoot = path.join(root, "node_modules", "@microsoft", "windows-ai-electron");
  const prebuildTriplet = resolveWindowsAiElectronPrebuildTriplet(platform, arch);
  const requiredFiles = [
    path.join(packageRoot, "package.json"),
    path.join(packageRoot, "index.js"),
    path.join(packageRoot, "windows-ai-electron", "prebuilds", prebuildTriplet, "node.node"),
  ];

  for (const requiredFile of requiredFiles) {
    if (!(await pathExists(requiredFile))) {
      console.warn(
        `[resources] Windows AI Electron: optional package payload missing, disabling Phi Silica support (${requiredFile})`,
      );
      return null;
    }
  }

  return {
    packageRoot,
    prebuildTriplet,
    fingerprintTargets: requiredFiles,
  };
}

async function copyIfExists(src: string, dest: string): Promise<void> {
  if (!(await pathExists(src))) {
    return;
  }
  await fs.copyFile(src, dest);
}

async function syncWindowsAiElectronPackage(opts: {
  root: string;
  dest: string;
  previousFingerprint: string | null;
  nextFingerprint: string | null;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<void> {
  if (!shouldBundleWindowsAiElectronPackage(opts.platform, opts.arch)) {
    await rmrf(opts.dest);
    console.log("[resources] Windows AI Electron: disabled");
    return;
  }

  const inputs = await ensureWindowsAiElectronInputs(opts.root, opts.platform, opts.arch);
  if (!inputs) {
    await rmrf(opts.dest);
    return;
  }

  const nativeRelativePath = path.join(
    "windows-ai-electron",
    "prebuilds",
    inputs.prebuildTriplet,
    "node.node",
  );
  const currentLooksComplete =
    (await pathExists(path.join(opts.dest, "index.js"))) &&
    (await pathExists(path.join(opts.dest, nativeRelativePath)));
  if (opts.previousFingerprint === opts.nextFingerprint && currentLooksComplete) {
    console.log("[resources] Windows AI Electron: cached");
    return;
  }

  await rmrf(opts.dest);
  await fs.mkdir(path.dirname(path.join(opts.dest, nativeRelativePath)), { recursive: true });
  await fs.copyFile(path.join(inputs.packageRoot, "index.js"), path.join(opts.dest, "index.js"));
  await copyIfExists(
    path.join(inputs.packageRoot, "package.json"),
    path.join(opts.dest, "package.json"),
  );
  await copyIfExists(path.join(inputs.packageRoot, "LICENSE"), path.join(opts.dest, "LICENSE"));
  await fs.copyFile(
    path.join(inputs.packageRoot, nativeRelativePath),
    path.join(opts.dest, nativeRelativePath),
  );
  console.log("[resources] Windows AI Electron: updated");
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
    (await pathExists(path.join(opts.dest, "node_modules", "koffi", "index.js"))) &&
    (await pathExists(path.join(opts.dest, "node_modules", "koffi", "package.json"))) &&
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
  const shouldBundleArtifactRuntime = process.env.COWORK_BUNDLE_ARTIFACT_RUNTIME === "1";
  const artifactRuntimeSource = shouldBundleArtifactRuntime
    ? await resolveArtifactRuntimeSource()
    : null;
  if (shouldBundleArtifactRuntime && !artifactRuntimeSource) {
    throw new Error(
      "COWORK_BUNDLE_ARTIFACT_RUNTIME=1 but no artifact runtime cache was found. Set COWORK_ARTIFACT_RUNTIME_DIR or run `bun run setup:artifact-runtime` first.",
    );
  }
  const promptsFingerprint = await fingerprintInputs([promptsSrc], root);
  const configFingerprint = await fingerprintInputs([configSrc], root);
  const skillsFingerprint = await fingerprintInputs([skillsSrc], root);
  const codexPrimaryRuntimeFingerprint = codexPrimaryRuntimeSource
    ? await fingerprintInputs([codexPrimaryRuntimeSource], codexPrimaryRuntimeSource)
    : null;
  const artifactRuntimeFingerprint = artifactRuntimeSource
    ? await fingerprintInputs([artifactRuntimeSource], artifactRuntimeSource)
    : null;
  const foundationModelsSdkInputs = shouldBundleFoundationModelsSdk(platform, arch)
    ? await ensureFoundationModelsSdkInputs(root)
    : null;
  const foundationModelsSdkFingerprint = foundationModelsSdkInputs
    ? await fingerprintInputs(foundationModelsSdkInputs.fingerprintTargets, root)
    : null;
  const windowsAiElectronInputs = shouldBundleWindowsAiElectronPackage(platform, arch)
    ? await ensureWindowsAiElectronInputs(root, platform, arch)
    : null;
  const windowsAiElectronFingerprint = windowsAiElectronInputs
    ? await fingerprintInputs(windowsAiElectronInputs.fingerprintTargets, root)
    : null;
  const docsFingerprint = includeDocs ? await fingerprintInputs([docsSrc], root) : null;
  const sidecarFingerprint = await fingerprintInputs(sidecarInputs, root);

  const desktopBinariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  const sidecarOutfile = path.join(
    desktopBinariesDir,
    resolvePackagedSidecarFilename(platform, arch),
  );
  const sidecarManifestPath = path.join(desktopBinariesDir, "cowork-server-manifest.json");
  const foundationModelsSdkDest = path.join(desktopBinariesDir, FOUNDATION_MODELS_SDK_DIR_NAME);
  const windowsAiElectronDest = path.join(desktopBinariesDir, WINDOWS_AI_ELECTRON_DIR_NAME);
  const bundledBunPath = path.join(desktopBinariesDir, SIDECAR_BUN_EXECUTABLE_NAME);
  const bundledEntrypointPath = path.join(desktopBinariesDir, SIDECAR_BUN_ENTRYPOINT_PATH);
  const compiledManagedSofficeHelperPath = path.join(
    desktopBinariesDir,
    MANAGED_SOFFICE_HELPER_RELATIVE_PATH,
  );
  const bundledManagedSofficeHelperPath = path.join(
    path.dirname(bundledEntrypointPath),
    MANAGED_SOFFICE_HELPER_RELATIVE_PATH,
  );
  const useBundledBunRuntime = shouldUseBundledBunRuntime(platform, arch);
  const bundledBunRuntimeVersion = useBundledBunRuntime
    ? resolveBundledBunRuntimeVersion(target)
    : null;
  const sidecarNeedsBuild =
    cache?.platform !== platform ||
    cache?.arch !== arch ||
    cache?.includeDocs !== includeDocs ||
    cache?.sidecarFingerprint !== sidecarFingerprint ||
    cache?.bundledBunRuntimeVersion !== bundledBunRuntimeVersion ||
    !(await pathExists(sidecarManifestPath)) ||
    (useBundledBunRuntime
      ? !(await pathExists(bundledBunPath)) ||
        !(await pathExists(bundledEntrypointPath)) ||
        !(await pathExists(bundledManagedSofficeHelperPath))
      : !(await pathExists(sidecarOutfile)) ||
        !(await pathExists(compiledManagedSofficeHelperPath)));

  if (sidecarNeedsBuild) {
    const entry = path.join(root, "src", "server", "index.ts");
    await rmrf(desktopBinariesDir);
    await fs.mkdir(desktopBinariesDir, { recursive: true });

    const manifest = buildSidecarManifest(platform, arch);
    if (useBundledBunRuntime) {
      const bundledEntrypointDir = path.dirname(bundledEntrypointPath);
      await fs.mkdir(bundledEntrypointDir, { recursive: true });
      const previousDesktopBundleEnv = process.env.COWORK_DESKTOP_BUNDLE;
      process.env.COWORK_DESKTOP_BUNDLE = "1";
      try {
        await buildBunBundle({
          entry,
          env: "COWORK_DESKTOP_BUNDLE*",
          minify: false,
          outfile: bundledEntrypointPath,
        });
      } finally {
        if (previousDesktopBundleEnv === undefined) {
          delete process.env.COWORK_DESKTOP_BUNDLE;
        } else {
          process.env.COWORK_DESKTOP_BUNDLE = previousDesktopBundleEnv;
        }
      }

      const { executablePath, version } = await ensureBundledBunRuntime(root, target);
      await fs.copyFile(executablePath, bundledBunPath);
      await fs.mkdir(path.dirname(bundledManagedSofficeHelperPath), { recursive: true });
      await fs.copyFile(
        path.join(root, "src", "managedSofficeRuntime", MANAGED_SOFFICE_HELPER_RELATIVE_PATH),
        bundledManagedSofficeHelperPath,
      );
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
      await fs.mkdir(path.dirname(compiledManagedSofficeHelperPath), { recursive: true });
      await fs.copyFile(
        path.join(root, "src", "managedSofficeRuntime", MANAGED_SOFFICE_HELPER_RELATIVE_PATH),
        compiledManagedSofficeHelperPath,
      );
      console.log(`[resources] sidecar: rebuilt ${path.relative(root, sidecarOutfile)}`);
    }

    await fs.writeFile(sidecarManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log("[resources] sidecar: cached");
  }

  await removeLegacyCodexAppServerBinaries(desktopBinariesDir);
  console.log("[resources] codex app-server: runtime-managed");

  const promptsDest = path.join(distDir, "prompts");
  const configDest = path.join(distDir, "config");
  const skillsDest = path.join(distDir, "skills");
  const codexPrimaryRuntimeDest = path.join(distDir, "codex-primary-runtime");
  const artifactRuntimeDest = path.join(distDir, "artifact-runtime");

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

  if (artifactRuntimeSource && artifactRuntimeFingerprint) {
    await syncCopiedDir({
      label: "artifact runtime",
      src: artifactRuntimeSource,
      dest: artifactRuntimeDest,
      previousFingerprint: cache?.artifactRuntimeFingerprint ?? null,
      nextFingerprint: artifactRuntimeFingerprint,
    });
  } else {
    await rmrf(artifactRuntimeDest);
    await fs.mkdir(artifactRuntimeDest, { recursive: true });
    console.log("[resources] artifact runtime: disabled");
  }

  await syncFoundationModelsSdk({
    root,
    dest: foundationModelsSdkDest,
    previousFingerprint: cache?.foundationModelsSdkFingerprint ?? null,
    nextFingerprint: foundationModelsSdkFingerprint,
    platform,
    arch,
  });

  await syncWindowsAiElectronPackage({
    root,
    dest: windowsAiElectronDest,
    previousFingerprint: cache?.windowsAiElectronFingerprint ?? null,
    nextFingerprint: windowsAiElectronFingerprint,
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
    promptsFingerprint,
    configFingerprint,
    skillsFingerprint,
    codexPrimaryRuntimeFingerprint,
    artifactRuntimeFingerprint,
    foundationModelsSdkFingerprint,
    windowsAiElectronFingerprint,
    docsFingerprint,
    bundledBunRuntimeVersion,
  });

  console.log("[resources] skipped dist/server desktop bundle (unused at runtime)");

  await pruneStaleDesktopBinaryArtifacts(desktopBinariesDir);
}

async function pruneStaleDesktopBinaryArtifacts(desktopBinariesDir: string): Promise<void> {
  if (!(await pathExists(desktopBinariesDir))) {
    return;
  }

  const staleNames = new Set([".DS_Store"]);
  const staleSuffixes = [".map", ".map.json", ".tsbuildinfo"];

  let removed = 0;
  const stack: string[] = [desktopBinariesDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (
        staleNames.has(entry.name) ||
        staleSuffixes.some((suffix) => entry.name.endsWith(suffix))
      ) {
        await fs.rm(full, { force: true });
        removed += 1;
      }
    }
  }

  if (removed > 0) {
    console.log(
      `[resources] desktop binaries: pruned ${removed} stale artifact${removed === 1 ? "" : "s"} (sourcemaps, tsbuildinfo, .DS_Store)`,
    );
  }
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export const __internal = {
  ensureFoundationModelsSdkInputs,
  syncFoundationModelsSdk,
  ensureWindowsAiElectronInputs,
  syncWindowsAiElectronPackage,
  pruneStaleDesktopBinaryArtifacts,
};
