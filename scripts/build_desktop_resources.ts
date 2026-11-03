import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildSidecarManifest,
  resolvePackagedSidecarFilename,
  SIDECAR_MANIFEST_NAME,
} from "../apps/desktop/electron/services/sidecar";
import { hostArch, hostPlatform } from "../src/platform/host";
import { WINDOWS_SANDBOX_HELPER_NAME } from "../src/platform/sandbox/windows";
import { isNativeWindowsBinary } from "../src/platform/windowsBinary";
import {
  copyDir,
  pathExists,
  resolveBuildTarget,
  resolveRustCompileTarget,
  rmrf,
} from "./releaseBuildUtils";
import { buildWindowsRustCommandRunner, syncWindowsSandboxHelper } from "./windowsSandboxBundle";
import { buildWorkspaceReleaseBinaries } from "./workspaceRustBinary";

const CACHE_VERSION = 15;
const LEGACY_BUN_EXECUTABLE_NAME = "bun.exe";
const LEGACY_BUN_ENTRYPOINT_DIR = "server";
// Node-API title-generation addons the Bun sidecar loaded; the Rust sidecar never reads them.
const LEGACY_NATIVE_TITLE_ADDON_DIRS = ["tsfm-sdk", "windows-ai-electron"];

type DesktopResourcesCache = {
  version: number;
  platform: NodeJS.Platform;
  arch: string;
  includeDocs: boolean;
  sidecarFingerprint: string;
  promptsFingerprint: string;
  configFingerprint: string;
  skillsFingerprint: string;
  workflowsFingerprint: string;
  windowsSandboxHelperFingerprint: string | null;
  docsFingerprint: string | null;
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
      if (entry.isDirectory() && entry.name === "target") {
        continue;
      }
      const childPath = path.join(target, entry.name);
      if (
        entry.isDirectory() &&
        path.relative(relativeTo, childPath) === path.join("crates", "cowork-win-sandbox")
      ) {
        continue;
      }
      await walkForFingerprint(childPath, relativeTo, acc);
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  const relative = path.relative(relativeTo, target);
  const contentHash = createHash("sha256")
    .update(await fs.readFile(target))
    .digest("hex");
  acc.push(`${relative}:${contentHash}`);
}

async function fingerprintInputs(
  targets: string[],
  root: string,
  compilerIdentity = "",
): Promise<string> {
  const acc: string[] = compilerIdentity ? [`compiler:${compilerIdentity}`] : [];
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
      typeof parsed.workflowsFingerprint !== "string" ||
      (parsed.windowsSandboxHelperFingerprint !== null &&
        typeof parsed.windowsSandboxHelperFingerprint !== "string") ||
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

async function removeLegacyNativeTitleAddons(desktopBinariesDir: string): Promise<void> {
  for (const dirName of LEGACY_NATIVE_TITLE_ADDON_DIRS) {
    await rmrf(path.join(desktopBinariesDir, dirName));
  }
}

async function clearDesktopSidecarArtifacts(desktopBinariesDir: string): Promise<void> {
  if (!(await pathExists(desktopBinariesDir))) {
    return;
  }

  const entries = await fs.readdir(desktopBinariesDir, { withFileTypes: true });
  for (const entry of entries) {
    const isSidecarArtifact =
      (entry.isFile() &&
        (entry.name.startsWith("cowork-server-") ||
          entry.name === SIDECAR_MANIFEST_NAME ||
          entry.name === LEGACY_BUN_EXECUTABLE_NAME)) ||
      (entry.isDirectory() && entry.name === LEGACY_BUN_ENTRYPOINT_DIR);
    if (isSidecarArtifact) {
      await rmrf(path.join(desktopBinariesDir, entry.name));
    }
  }
}

function resolveRustCompilerIdentity(): string {
  try {
    const proc = Bun.spawnSync(["rustc", "-vV"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      const text = new TextDecoder().decode(proc.stdout).trim();
      if (text) {
        return text;
      }
    }
  } catch {
    // Fall back if rustc is not directly on PATH (e.g. custom Windows toolchain setup).
  }
  return "rustc:unknown";
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const forceWindowsSandboxBuild = rawArgs.includes("--force-windows-sandbox-build");
  const target = resolveBuildTarget(
    rawArgs.filter((arg) => arg !== "--force-windows-sandbox-build"),
  );
  const { platform, arch } = target;
  const rustTarget = resolveRustCompileTarget(platform, arch);
  const root = path.resolve(import.meta.dirname, "..");
  const distDir = path.join(root, "dist");
  const includeDocs = process.env.COWORK_BUNDLE_DESKTOP_DOCS === "1";
  const cachePath = path.join(distDir, `.desktop-resources-cache-${platform}-${arch}.json`);

  await fs.mkdir(distDir, { recursive: true });
  await rmrf(path.join(distDir, "server"));
  await rmrf(path.join(distDir, "codex-primary-runtime"));
  await rmrf(path.join(distDir, "artifact-runtime"));

  const cache = await loadCache(cachePath);

  const sidecarInputs = [
    path.join(root, "Cargo.toml"),
    path.join(root, "Cargo.lock"),
    path.join(root, "crates"),
    path.join(root, "config"),
    path.join(root, "prompts"),
    path.join(root, "apps", "desktop", "electron", "services", "sidecar.ts"),
    path.join(root, "scripts", "build_desktop_resources.ts"),
    path.join(root, "scripts", "releaseBuildUtils.ts"),
    path.join(root, "scripts", "workspaceRustBinary.ts"),
  ];
  const promptsSrc = path.join(root, "prompts");
  const configSrc = path.join(root, "config");
  const skillsSrc = path.join(root, "skills");
  const workflowsSrc = path.join(root, "workflows");
  const docsSrc = path.join(root, "docs");
  const promptsFingerprint = await fingerprintInputs([promptsSrc], root);
  const configFingerprint = await fingerprintInputs([configSrc], root);
  const skillsFingerprint = await fingerprintInputs([skillsSrc], root);
  const workflowsFingerprint = await fingerprintInputs([workflowsSrc], root);
  const windowsSandboxHelperInputs =
    platform === "win32"
      ? [
          path.join(root, "crates", "cowork-win-sandbox", "Cargo.toml"),
          path.join(root, "crates", "cowork-win-sandbox", "Cargo.lock"),
          path.join(root, "crates", "cowork-win-sandbox", "build.rs"),
          path.join(root, "crates", "cowork-win-sandbox", "codex-windows-sandbox-setup.manifest"),
          path.join(root, "crates", "cowork-win-sandbox", "src"),
          path.join(root, "crates", "cowork-win-sandbox", "vendor"),
        ]
      : null;
  const windowsSandboxHelperFingerprint = windowsSandboxHelperInputs
    ? await fingerprintInputs(windowsSandboxHelperInputs, root)
    : null;
  const docsFingerprint = includeDocs ? await fingerprintInputs([docsSrc], root) : null;
  const sidecarFingerprint = await fingerprintInputs(
    sidecarInputs,
    root,
    resolveRustCompilerIdentity(),
  );

  const desktopBinariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  const sidecarOutfile = path.join(
    desktopBinariesDir,
    resolvePackagedSidecarFilename(platform, arch),
  );
  const sidecarManifestPath = path.join(desktopBinariesDir, SIDECAR_MANIFEST_NAME);
  const windowsSandboxHelperDest = path.join(desktopBinariesDir, WINDOWS_SANDBOX_HELPER_NAME);
  const sidecarNeedsBuild =
    cache?.platform !== platform ||
    cache?.arch !== arch ||
    cache?.includeDocs !== includeDocs ||
    cache?.sidecarFingerprint !== sidecarFingerprint ||
    !(await pathExists(sidecarManifestPath)) ||
    !(await pathExists(sidecarOutfile)) ||
    (platform === "win32" && !isNativeWindowsBinary(sidecarOutfile, arch));

  if (sidecarNeedsBuild) {
    await clearDesktopSidecarArtifacts(desktopBinariesDir);
    await fs.mkdir(desktopBinariesDir, { recursive: true });

    const manifest = buildSidecarManifest(platform, arch);
    const runner = buildWindowsRustCommandRunner(rustTarget);
    if (platform !== hostPlatform() || arch !== hostArch()) {
      await runner(["rustup", "target", "add", rustTarget], {
        cwd: root,
        env: process.env,
      });
    }

    const [builtSidecarPath] = await buildWorkspaceReleaseBinaries(
      root,
      rustTarget,
      ["cowork-server"],
      runner,
    );

    await fs.rm(sidecarOutfile, { force: true });
    await fs.copyFile(builtSidecarPath, sidecarOutfile);
    if (platform !== "win32") {
      await fs.chmod(sidecarOutfile, 0o755);
    }
    if (platform === "darwin" && hostPlatform() === "darwin") {
      await runner(["codesign", "--force", "--sign", "-", sidecarOutfile], {
        cwd: root,
        env: process.env,
      });
    }
    if (platform === "win32" && !isNativeWindowsBinary(sidecarOutfile, arch)) {
      throw new Error(
        `Compiled desktop sidecar is not a native Windows ${arch} executable: ${sidecarOutfile}`,
      );
    }
    console.log(`[resources] sidecar: rebuilt ${path.relative(root, sidecarOutfile)}`);

    await fs.writeFile(sidecarManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log("[resources] sidecar: cached");
  }

  await removeLegacyCodexAppServerBinaries(desktopBinariesDir);
  await removeLegacyNativeTitleAddons(desktopBinariesDir);
  console.log("[resources] codex app-server: runtime-managed");

  const promptsDest = path.join(distDir, "prompts");
  const configDest = path.join(distDir, "config");
  const skillsDest = path.join(distDir, "skills");
  const workflowsDest = path.join(distDir, "workflows");

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

  await syncCopiedDir({
    label: "workflows",
    src: workflowsSrc,
    dest: workflowsDest,
    previousFingerprint: cache?.workflowsFingerprint ?? null,
    nextFingerprint: workflowsFingerprint,
  });

  await syncWindowsSandboxHelper({
    root,
    dest: windowsSandboxHelperDest,
    previousFingerprint: cache?.windowsSandboxHelperFingerprint ?? null,
    nextFingerprint: windowsSandboxHelperFingerprint,
    platform,
    arch,
    forceBuild: forceWindowsSandboxBuild,
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
    workflowsFingerprint,
    windowsSandboxHelperFingerprint,
    docsFingerprint,
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
  fingerprintInputs,
  clearDesktopSidecarArtifacts,
  removeLegacyNativeTitleAddons,
  syncWindowsSandboxHelper,
  pruneStaleDesktopBinaryArtifacts,
};
