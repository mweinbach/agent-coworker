import type { PackagedBinaryManifest } from "./packagedBinary";
import {
  buildPackagedBinaryManifest,
  findPackagedBinary,
  resolveDesktopTargetTriple,
  resolvePackagedBinaryFilename,
} from "./packagedBinary";

export const LOOM_BRIDGE_BASE_NAME = "cowork-loom-bridge";
export const LOOM_BRIDGE_MANIFEST_NAME = "cowork-loom-bridge-manifest.json";

export type LoomBridgeManifest = PackagedBinaryManifest;

type FindPackagedLoomBridgeBinaryOptions = {
  explicitPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: typeof import("node:fs").existsSync;
  readFileSync?: typeof import("node:fs").readFileSync;
  readdirSync?: typeof import("node:fs").readdirSync;
};

export { resolveDesktopTargetTriple };

export function resolvePackagedLoomBridgeFilename(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return resolvePackagedBinaryFilename(LOOM_BRIDGE_BASE_NAME, platform, arch);
}

export function buildLoomBridgeManifest(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): LoomBridgeManifest {
  return buildPackagedBinaryManifest(LOOM_BRIDGE_BASE_NAME, platform, arch);
}

export function findPackagedLoomBridgeBinary(
  searchDirs: string[],
  options: FindPackagedLoomBridgeBinaryOptions = {}
): string {
  return findPackagedBinary(searchDirs, {
    ...options,
    baseName: LOOM_BRIDGE_BASE_NAME,
    manifestName: LOOM_BRIDGE_MANIFEST_NAME,
    notFoundLabel: "Loom bridge helper",
  });
}
