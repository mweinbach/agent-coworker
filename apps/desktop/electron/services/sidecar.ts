import fs from "node:fs";
import path from "node:path";

export const SIDECAR_BASE_NAME = "cowork-server";
export const SIDECAR_MANIFEST_NAME = "cowork-server-manifest.json";
export const SIDECAR_BUN_EXECUTABLE_NAME = "bun.exe";
export const SIDECAR_BUN_ENTRYPOINT_PATH = "server/index.js";

export type ExecutableSidecarLaunchSpec = {
  kind: "executable";
  path: string;
  args?: string[];
};

export type BunSidecarLaunchSpec = {
  kind: "bun";
  runtime: string;
  entrypoint: string;
  args?: string[];
};

export type SidecarLaunchSpec = ExecutableSidecarLaunchSpec | BunSidecarLaunchSpec;

export type SidecarManifest = {
  targetTriple: string;
  platform: NodeJS.Platform;
  arch: string;
  launch: SidecarLaunchSpec;
};

type LegacySidecarManifest = {
  filename: string;
  targetTriple: string;
  platform: NodeJS.Platform;
  arch: string;
};

export type SidecarLaunchCommand = {
  command: string;
  args: string[];
  targetTriple: string;
  platform: NodeJS.Platform;
  arch: string;
  manifestPath?: string;
};

export function resolveDesktopTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
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

export function shouldUseBundledBunRuntime(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  return platform === "win32" && arch === "arm64";
}

export function resolvePackagedSidecarFilename(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const ext = platform === "win32" ? ".exe" : "";
  return `${SIDECAR_BASE_NAME}-${resolveDesktopTargetTriple(platform, arch)}${ext}`;
}

export function buildSidecarManifest(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): SidecarManifest {
  const targetTriple = resolveDesktopTargetTriple(platform, arch);
  if (shouldUseBundledBunRuntime(platform, arch)) {
    return {
      targetTriple,
      platform,
      arch,
      launch: {
        kind: "bun",
        runtime: SIDECAR_BUN_EXECUTABLE_NAME,
        entrypoint: SIDECAR_BUN_ENTRYPOINT_PATH,
      },
    };
  }

  return {
    targetTriple,
    platform,
    arch,
    launch: {
      kind: "executable",
      path: resolvePackagedSidecarFilename(platform, arch),
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isExecutableLaunchSpec(value: unknown): value is ExecutableSidecarLaunchSpec {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "executable" &&
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    (candidate.args === undefined || isStringArray(candidate.args))
  );
}

function isBunLaunchSpec(value: unknown): value is BunSidecarLaunchSpec {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "bun" &&
    typeof candidate.runtime === "string" &&
    candidate.runtime.length > 0 &&
    typeof candidate.entrypoint === "string" &&
    candidate.entrypoint.length > 0 &&
    (candidate.args === undefined || isStringArray(candidate.args))
  );
}

function isSidecarLaunchSpec(value: unknown): value is SidecarLaunchSpec {
  return isExecutableLaunchSpec(value) || isBunLaunchSpec(value);
}

function isSidecarManifest(value: unknown): value is SidecarManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.targetTriple === "string" &&
    candidate.targetTriple.length > 0 &&
    typeof candidate.platform === "string" &&
    candidate.platform.length > 0 &&
    typeof candidate.arch === "string" &&
    candidate.arch.length > 0 &&
    isSidecarLaunchSpec(candidate.launch)
  );
}

function isLegacySidecarManifest(value: unknown): value is LegacySidecarManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.filename === "string" &&
    candidate.filename.length > 0 &&
    typeof candidate.targetTriple === "string" &&
    candidate.targetTriple.length > 0 &&
    typeof candidate.platform === "string" &&
    candidate.platform.length > 0 &&
    typeof candidate.arch === "string" &&
    candidate.arch.length > 0
  );
}

type FindPackagedSidecarLaunchOptions = {
  explicitPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: typeof fs.existsSync;
  readFileSync?: typeof fs.readFileSync;
  readdirSync?: typeof fs.readdirSync;
  lstatSync?: typeof fs.lstatSync;
};

function resolveRelativeManifestPath(dir: string, target: string): string {
  return path.isAbsolute(target) ? target : path.join(dir, target);
}

function buildSidecarLaunchCommand(
  dir: string,
  manifest: SidecarManifest | LegacySidecarManifest,
  existsSync: typeof fs.existsSync,
  manifestPath?: string
): SidecarLaunchCommand {
  if (isLegacySidecarManifest(manifest)) {
    const command = resolveRelativeManifestPath(dir, manifest.filename);
    if (!existsSync(command)) {
      throw new Error(
        `Bundled sidecar manifest points to a missing binary: ${manifestPath ?? dir} -> ${manifest.filename}`
      );
    }
    return {
      command,
      args: [],
      targetTriple: manifest.targetTriple,
      platform: manifest.platform,
      arch: manifest.arch,
      manifestPath,
    };
  }

  if (manifest.launch.kind === "executable") {
    const command = resolveRelativeManifestPath(dir, manifest.launch.path);
    if (!existsSync(command)) {
      throw new Error(
        `Bundled sidecar manifest points to a missing executable: ${manifestPath ?? dir} -> ${manifest.launch.path}`
      );
    }
    return {
      command,
      args: manifest.launch.args ?? [],
      targetTriple: manifest.targetTriple,
      platform: manifest.platform,
      arch: manifest.arch,
      manifestPath,
    };
  }

  const runtime = resolveRelativeManifestPath(dir, manifest.launch.runtime);
  if (!existsSync(runtime)) {
    throw new Error(
      `Bundled sidecar manifest points to a missing Bun runtime: ${manifestPath ?? dir} -> ${manifest.launch.runtime}`
    );
  }

  const entrypoint = resolveRelativeManifestPath(dir, manifest.launch.entrypoint);
  if (!existsSync(entrypoint)) {
    throw new Error(
      `Bundled sidecar manifest points to a missing Bun entrypoint: ${manifestPath ?? dir} -> ${manifest.launch.entrypoint}`
    );
  }

  return {
    command: runtime,
    args: [entrypoint, ...(manifest.launch.args ?? [])],
    targetTriple: manifest.targetTriple,
    platform: manifest.platform,
    arch: manifest.arch,
    manifestPath,
  };
}

function isDirectoryPath(target: string, lstatSync: typeof fs.lstatSync): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function findPackagedSidecarLaunchCommand(
  searchDirs: string[],
  options: FindPackagedSidecarLaunchOptions = {}
): SidecarLaunchCommand {
  const explicitPath = options.explicitPath?.trim();
  const existsSync = options.existsSync ?? fs.existsSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const targetTriple = resolveDesktopTargetTriple(platform, arch);

  const resolvedSearchDirs =
    explicitPath && existsSync(explicitPath) && isDirectoryPath(explicitPath, lstatSync)
      ? [explicitPath, ...searchDirs]
      : searchDirs;

  if (explicitPath && existsSync(explicitPath) && !isDirectoryPath(explicitPath, lstatSync)) {
    return {
      command: explicitPath,
      args: [],
      targetTriple,
      platform,
      arch,
    };
  }

  const expectedFilename = resolvePackagedSidecarFilename(platform, arch);
  const foundCandidates = new Set<string>();

  for (const dir of resolvedSearchDirs) {
    if (!existsSync(dir)) {
      continue;
    }

    const manifestPath = path.join(dir, SIDECAR_MANIFEST_NAME);
    if (existsSync(manifestPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch (error) {
        throw new Error(`Bundled sidecar manifest is unreadable: ${manifestPath} (${String(error)})`);
      }

      if (!isSidecarManifest(parsed) && !isLegacySidecarManifest(parsed)) {
        throw new Error(`Bundled sidecar manifest is invalid: ${manifestPath}`);
      }

      return buildSidecarLaunchCommand(dir, parsed, existsSync, manifestPath);
    }

    const exactPath = path.join(dir, expectedFilename);
    if (existsSync(exactPath)) {
      return {
        command: exactPath,
        args: [],
        targetTriple,
        platform,
        arch,
      };
    }

    for (const entry of readdirSync(dir)) {
      if (entry === SIDECAR_BASE_NAME || entry.startsWith(`${SIDECAR_BASE_NAME}-`)) {
        foundCandidates.add(path.join(dir, entry));
      }
    }
  }

  const foundSummary =
    foundCandidates.size > 0 ? ` Found candidates: ${[...foundCandidates].sort().join(", ")}` : "";

  throw new Error(
    `Server sidecar launch target not found. Expected ${expectedFilename} in ${resolvedSearchDirs.join(", ")}.${foundSummary}`
  );
}
