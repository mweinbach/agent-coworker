import fs from "node:fs";
import path from "node:path";

export type PackagedBinaryManifest = {
  filename: string;
  targetTriple: string;
  platform: NodeJS.Platform;
  arch: string;
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

  throw new Error(`Unsupported platform/arch for desktop packaged binary: ${platform}/${arch}`);
}

export function resolvePackagedBinaryFilename(
  baseName: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const ext = platform === "win32" ? ".exe" : "";
  return `${baseName}-${resolveDesktopTargetTriple(platform, arch)}${ext}`;
}

export function buildPackagedBinaryManifest(
  baseName: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): PackagedBinaryManifest {
  return {
    filename: resolvePackagedBinaryFilename(baseName, platform, arch),
    targetTriple: resolveDesktopTargetTriple(platform, arch),
    platform,
    arch,
  };
}

function isPackagedBinaryManifest(value: unknown): value is PackagedBinaryManifest {
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

type FindPackagedBinaryOptions = {
  baseName: string;
  manifestName: string;
  explicitPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: typeof fs.existsSync;
  readFileSync?: typeof fs.readFileSync;
  readdirSync?: typeof fs.readdirSync;
  notFoundLabel?: string;
};

export function findPackagedBinary(
  searchDirs: string[],
  options: FindPackagedBinaryOptions
): string {
  const explicitPath = options.explicitPath?.trim();
  const existsSync = options.existsSync ?? fs.existsSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  const expectedFilename = resolvePackagedBinaryFilename(options.baseName, platform, arch);
  const foundCandidates = new Set<string>();

  for (const dir of searchDirs) {
    if (!existsSync(dir)) {
      continue;
    }

    const manifestPath = path.join(dir, options.manifestName);
    if (existsSync(manifestPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch (error) {
        throw new Error(`Bundled manifest is unreadable: ${manifestPath} (${String(error)})`);
      }

      if (!isPackagedBinaryManifest(parsed)) {
        throw new Error(`Bundled manifest is invalid: ${manifestPath}`);
      }

      const manifestBinary = path.join(dir, parsed.filename);
      if (!existsSync(manifestBinary)) {
        throw new Error(`Bundled manifest points to a missing binary: ${manifestPath} -> ${parsed.filename}`);
      }

      return manifestBinary;
    }

    const exactPath = path.join(dir, expectedFilename);
    if (existsSync(exactPath)) {
      return exactPath;
    }

    for (const entry of readdirSync(dir)) {
      if (entry === options.baseName || entry.startsWith(`${options.baseName}-`)) {
        foundCandidates.add(path.join(dir, entry));
      }
    }
  }

  const foundSummary =
    foundCandidates.size > 0 ? ` Found candidates: ${[...foundCandidates].sort().join(", ")}` : "";
  const label = options.notFoundLabel ?? "Packaged binary";

  throw new Error(
    `${label} not found. Expected ${expectedFilename} in ${searchDirs.join(", ")}.${foundSummary}`
  );
}
