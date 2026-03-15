import type { PackagedBinaryManifest } from "./packagedBinary";
import {
  buildPackagedBinaryManifest,
  findPackagedBinary,
  resolveDesktopTargetTriple,
  resolvePackagedBinaryFilename,
} from "./packagedBinary";

export const SIDECAR_BASE_NAME = "cowork-server";
export const SIDECAR_MANIFEST_NAME = "cowork-server-manifest.json";

export type SidecarManifest = PackagedBinaryManifest;

type FindPackagedSidecarBinaryOptions = {
  explicitPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: typeof import("node:fs").existsSync;
  readFileSync?: typeof import("node:fs").readFileSync;
  readdirSync?: typeof import("node:fs").readdirSync;
};

export { resolveDesktopTargetTriple };

export function resolvePackagedSidecarFilename(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return resolvePackagedBinaryFilename(SIDECAR_BASE_NAME, platform, arch);
}

export function buildSidecarManifest(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): SidecarManifest {
  return buildPackagedBinaryManifest(SIDECAR_BASE_NAME, platform, arch);
}

export function findPackagedSidecarBinary(
  searchDirs: string[],
  options: FindPackagedSidecarBinaryOptions = {}
): string {
  return findPackagedBinary(searchDirs, {
    ...options,
    baseName: SIDECAR_BASE_NAME,
    manifestName: SIDECAR_MANIFEST_NAME,
    notFoundLabel: "Server sidecar binary",
  });
}
