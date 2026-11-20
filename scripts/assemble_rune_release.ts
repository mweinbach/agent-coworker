import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildLatestJsonManifest,
  buildReleaseDownloadUrl,
  DEFAULT_GITHUB_OWNER,
  DEFAULT_GITHUB_REPO,
  type LatestJsonManifest,
  normalizeSemverVersion,
  readFragmentsFromDirectory,
  type UpdaterFragment,
  type UpdaterPlatformKey,
  VALID_UPDATER_PLATFORM_KEYS,
  validateLatestJsonManifest,
} from "./desktop_rune_release_manifest";
import {
  collectMacZipFilesInDir,
  LEGACY_MAC_CHANNEL_FILENAME,
  type MacLegacyArch,
  parseLegacyMacChannelYaml,
  selectLegacyMacZipForClient,
  validateLegacyMacChannelMetadata,
  writeLegacyMacChannelFile,
} from "./legacy_mac_updater";
import {
  LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME,
  LEGACY_WINDOWS_X64_CHANNEL_FILENAME,
  parseLegacyWindowsChannelYaml,
  selectLegacyWindowsInstallerForClient,
  validateLegacyWindowsChannelMetadata,
  type WindowsLegacyArch,
  writeLegacyWindowsChannelFilesForDir,
} from "./legacy_windows_updater";

export const ORIGINATING_ELECTRON_VERSION = "1.3.1";
export const ORIGINATING_ELECTRON_TAG = "v1.3.1";
export const ORIGINATING_ELECTRON_COMMIT = "cca703383c5b7632b159d655d0e647157473835f";

export const REQUIRED_BRIDGE_PLATFORM_KEYS: readonly UpdaterPlatformKey[] = [
  ...VALID_UPDATER_PLATFORM_KEYS,
];
export const REQUIRED_LEGACY_MAC_ARCHES: readonly MacLegacyArch[] = ["arm64", "x64"];
export const REQUIRED_LEGACY_WINDOWS_ARCHES: readonly WindowsLegacyArch[] = ["x64", "arm64"];

export interface PackageSummaryRecord {
  platformKey: UpdaterPlatformKey;
  rustTarget?: string;
  version: string;
  signedPlatform: boolean;
  notarized: boolean;
  signedUpdater: boolean;
  artifacts: string[];
  updaterFragment?: string | null;
  legacyMacChannel?: string | null;
  legacyMacZip?: {
    fileName: string;
    sha512: string;
    size: number;
  } | null;
  legacyWindowsChannel?: string | null;
  legacyWindowsInstaller?: {
    fileName: string;
    sha512: string;
    size: number;
  } | null;
}

export interface AssembledReleaseResult {
  version: string;
  tag: string;
  pubDate: string;
  outDir: string;
  latestJsonPath: string | null;
  legacyMacChannelPath: string | null;
  legacyWindowsChannelPaths: string[];
  assets: string[];
  manifest: LatestJsonManifest | null;
}

export interface VerifyAssembledReleaseResult {
  version: string;
  tag: string;
  dir: string;
  latestJsonPlatforms: UpdaterPlatformKey[];
  legacyMacZips: Record<MacLegacyArch, string>;
  legacyWindowsInstallers: Record<WindowsLegacyArch, string>;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_PARTS_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_ID_RE = /^\d+$/;

function parseSemverParts(raw: string): ParsedSemver {
  const normalized = normalizeSemverVersion(raw);
  const match = SEMVER_PARTS_RE.exec(normalized);
  if (!match) {
    throw new Error(`Invalid semantic version "${raw}".`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/**
 * Compares two SemVer 2.0 versions. Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemver(aRaw: string, bRaw: string): -1 | 0 | 1 {
  const a = parseSemverParts(aRaw);
  const b = parseSemverParts(bRaw);

  for (const [av, bv] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    if (av !== bv) return av < bv ? -1 : 1;
  }

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;

    const aNum = NUMERIC_ID_RE.test(ai);
    const bNum = NUMERIC_ID_RE.test(bi);
    if (aNum && bNum) {
      return Number(ai) < Number(bi) ? -1 : 1;
    }
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

export function computeNextPatchVersion(rawVersion: string): string {
  const parts = parseSemverParts(rawVersion);
  return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
}

export function parseVersionFromReleaseTag(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) {
    throw new Error("Release tag must not be empty.");
  }
  let rawVersion: string;
  if (trimmed.startsWith("desktop-rune-v")) {
    rawVersion = trimmed.slice("desktop-rune-v".length);
  } else if (trimmed.startsWith("v")) {
    rawVersion = trimmed.slice(1);
  } else {
    throw new Error(
      `Unsupported desktop release tag "${tag}". Expected "v<semver>" or "desktop-rune-v<semver>".`,
    );
  }
  return normalizeSemverVersion(rawVersion);
}

export function assertReleaseTagMatchesVersion(tag: string, version: string): void {
  const expectedVersion = normalizeSemverVersion(version);
  const tagVersion = parseVersionFromReleaseTag(tag);
  if (tagVersion !== expectedVersion) {
    throw new Error(
      `Release tag "${tag}" encodes version ${tagVersion}, which does not match release version ${expectedVersion}.`,
    );
  }
}

export function assertCandidateNewerThanOriginating(
  candidateVersion: string,
  originatingVersion: string = ORIGINATING_ELECTRON_VERSION,
): void {
  const candidate = normalizeSemverVersion(candidateVersion);
  const originating = normalizeSemverVersion(originatingVersion);
  if (compareSemver(candidate, originating) <= 0) {
    throw new Error(
      `Candidate release version ${candidate} must be strictly newer than the supported originating Electron client version ${originating}.`,
    );
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

async function computeFileSha512AndSize(
  filePath: string,
): Promise<{ sha512: string; size: number }> {
  const bytes = await fs.readFile(filePath);
  return {
    sha512: createHash("sha512").update(bytes).digest("base64"),
    size: bytes.length,
  };
}

function isInternalMetadataFile(baseName: string): boolean {
  return (
    (baseName.startsWith("updater-fragment-") && baseName.endsWith(".json")) ||
    (baseName.startsWith("package-summary-") && baseName.endsWith(".json")) ||
    (baseName.startsWith("bridge-upgrade-result-") && baseName.endsWith(".json"))
  );
}

function isGeneratedChannelFeedFile(baseName: string): boolean {
  return (
    baseName === "latest.json" ||
    baseName === LEGACY_MAC_CHANNEL_FILENAME ||
    baseName === LEGACY_WINDOWS_X64_CHANNEL_FILENAME ||
    baseName === LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME
  );
}

export async function readPackageSummariesFromDirectory(
  dir: string,
): Promise<PackageSummaryRecord[]> {
  const allFiles = await listFilesRecursive(dir);
  const summaries: PackageSummaryRecord[] = [];
  const seen = new Set<string>();

  for (const file of allFiles) {
    const base = path.basename(file);
    if (!base.startsWith("package-summary-") || !base.endsWith(".json")) {
      continue;
    }
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<PackageSummaryRecord>;
    if (
      typeof raw.platformKey !== "string" ||
      typeof raw.version !== "string" ||
      typeof raw.signedPlatform !== "boolean" ||
      typeof raw.notarized !== "boolean" ||
      typeof raw.signedUpdater !== "boolean" ||
      !Array.isArray(raw.artifacts)
    ) {
      throw new Error(`Malformed package summary file: ${file}`);
    }
    if (seen.has(raw.platformKey)) {
      throw new Error(`Duplicate package summary for platform ${raw.platformKey}: ${file}`);
    }
    seen.add(raw.platformKey);
    summaries.push(raw as PackageSummaryRecord);
  }
  return summaries;
}

export function validatePackageSummaries(params: {
  summaries: readonly PackageSummaryRecord[];
  version: string;
  requireComplete: boolean;
  requireSigned: boolean;
}): void {
  const expectedVersion = normalizeSemverVersion(params.version);
  const byPlatform = new Map<UpdaterPlatformKey, PackageSummaryRecord>();

  for (const summary of params.summaries) {
    const summaryVersion = normalizeSemverVersion(summary.version);
    if (summaryVersion !== expectedVersion) {
      throw new Error(
        `Package summary for ${summary.platformKey} reports version ${summaryVersion}, expected ${expectedVersion}.`,
      );
    }
    byPlatform.set(summary.platformKey, summary);
  }

  if (params.requireComplete) {
    for (const key of REQUIRED_BRIDGE_PLATFORM_KEYS) {
      if (!byPlatform.has(key)) {
        throw new Error(
          `Missing package-summary-${key}.json for required release platform "${key}".`,
        );
      }
    }
  }

  if (params.requireSigned) {
    if (byPlatform.size === 0) {
      throw new Error("requireSigned=true requires package-summary-*.json signing attestations.");
    }
    for (const [key, summary] of byPlatform.entries()) {
      if (!summary.signedUpdater) {
        throw new Error(
          `Release platform "${key}" did not produce a Minisign-signed updater payload (signedUpdater=false).`,
        );
      }
      if (key.startsWith("macos-")) {
        if (!summary.signedPlatform) {
          throw new Error(
            `macOS release platform "${key}" is not Developer ID codesigned (signedPlatform=false).`,
          );
        }
        if (!summary.notarized) {
          throw new Error(
            `macOS release platform "${key}" is not Apple notarized (notarized=false).`,
          );
        }
      } else if (key.startsWith("windows-")) {
        if (!summary.signedPlatform) {
          throw new Error(
            `Windows release platform "${key}" is not Authenticode signed (signedPlatform=false).`,
          );
        }
      }
    }
  }
}

async function verifySummaryDigestMatchesStagedFile(params: {
  outDir: string;
  platformKey: string;
  label: string;
  expected: { fileName: string; sha512: string; size: number };
}): Promise<void> {
  const filePath = path.join(params.outDir, params.expected.fileName);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(
      `Summary for ${params.platformKey} references ${params.label} "${params.expected.fileName}", which is missing in ${params.outDir}.`,
    );
  }
  const actual = await computeFileSha512AndSize(filePath);
  if (actual.size !== params.expected.size || actual.sha512 !== params.expected.sha512) {
    throw new Error(
      `Final staged bytes for ${params.expected.fileName} (${params.platformKey}) drifted from package summary (size ${actual.size} vs ${params.expected.size}, sha512 ${actual.sha512} vs ${params.expected.sha512}).`,
    );
  }
}

export async function assembleRuneRelease(params: {
  artifactsDir: string;
  outDir: string;
  version: string;
  tag: string;
  owner?: string;
  repo?: string;
  pubDate?: string;
  notes?: string;
  requireComplete?: boolean;
  requireSigned?: boolean;
  minOriginatingVersion?: string | null;
}): Promise<AssembledReleaseResult> {
  const version = normalizeSemverVersion(params.version);
  const tag = params.tag.trim();
  const owner = (params.owner ?? DEFAULT_GITHUB_OWNER).trim();
  const repo = (params.repo ?? DEFAULT_GITHUB_REPO).trim();
  const pubDate = (params.pubDate ?? new Date().toISOString()).trim();
  const requireComplete = params.requireComplete ?? false;
  const requireSigned = params.requireSigned ?? false;
  const minOriginatingVersion =
    params.minOriginatingVersion === undefined
      ? requireComplete
        ? ORIGINATING_ELECTRON_VERSION
        : null
      : params.minOriginatingVersion;

  assertReleaseTagMatchesVersion(tag, version);
  if (minOriginatingVersion) {
    assertCandidateNewerThanOriginating(version, minOriginatingVersion);
  }

  const artifactsDir = path.resolve(params.artifactsDir);
  const outDir = path.resolve(params.outDir);

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const allInputFiles = await listFilesRecursive(artifactsDir);
  const copiedByBasename = new Map<string, { source: string; sha512: string }>();

  for (const srcPath of allInputFiles) {
    const baseName = path.basename(srcPath);
    if (isInternalMetadataFile(baseName) || isGeneratedChannelFeedFile(baseName)) {
      continue;
    }
    const destPath = path.join(outDir, baseName);
    const { sha512 } = await computeFileSha512AndSize(srcPath);
    const existing = copiedByBasename.get(baseName);
    if (existing) {
      if (existing.sha512 !== sha512) {
        throw new Error(
          `Conflicting duplicate release asset "${baseName}" from ${existing.source} and ${srcPath}.`,
        );
      }
      continue;
    }
    await fs.copyFile(srcPath, destPath);
    copiedByBasename.set(baseName, { source: srcPath, sha512 });
  }

  const summaries = await readPackageSummariesFromDirectory(artifactsDir);
  if (summaries.length > 0 || requireComplete || requireSigned) {
    validatePackageSummaries({
      summaries,
      version,
      requireComplete,
      requireSigned,
    });
  }

  for (const summary of summaries) {
    if (summary.legacyMacZip) {
      await verifySummaryDigestMatchesStagedFile({
        outDir,
        platformKey: summary.platformKey,
        label: "legacy macOS ZIP",
        expected: summary.legacyMacZip,
      });
    }
    if (summary.legacyWindowsInstaller) {
      await verifySummaryDigestMatchesStagedFile({
        outDir,
        platformKey: summary.platformKey,
        label: "legacy Windows installer",
        expected: summary.legacyWindowsInstaller,
      });
    }
  }

  const fragments: UpdaterFragment[] = await readFragmentsFromDirectory(artifactsDir);
  let manifest: LatestJsonManifest | null = null;
  let latestJsonPath: string | null = null;
  if (fragments.length > 0) {
    if (requireComplete) {
      const presentKeys = new Set(fragments.map((f) => f.platformKey));
      for (const requiredKey of REQUIRED_BRIDGE_PLATFORM_KEYS) {
        if (!presentKeys.has(requiredKey)) {
          throw new Error(
            `Missing updater fragment for required platform "${requiredKey}" while assembling ${tag}.`,
          );
        }
      }
    }
    manifest = buildLatestJsonManifest({
      version,
      tag,
      owner,
      repo,
      notes: params.notes,
      pubDate,
      fragments,
    });
    latestJsonPath = path.join(outDir, "latest.json");
    await fs.writeFile(latestJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } else if (requireComplete || requireSigned) {
    throw new Error(
      `No updater-fragment-*.json files found in ${artifactsDir} while requireComplete/requireSigned is enabled.`,
    );
  }

  const macZips = await collectMacZipFilesInDir(outDir);
  let legacyMacChannelPath: string | null = null;
  if (macZips.length > 0) {
    legacyMacChannelPath = path.join(outDir, LEGACY_MAC_CHANNEL_FILENAME);
    await writeLegacyMacChannelFile({
      version,
      zipPaths: macZips,
      outPath: legacyMacChannelPath,
      releaseDate: pubDate,
      requiredArches: requireComplete ? REQUIRED_LEGACY_MAC_ARCHES : undefined,
    });
  } else if (requireComplete) {
    throw new Error(
      `No macOS *-mac.zip files found in ${outDir} while requireComplete is enabled.`,
    );
  }

  const winExes = (await fs.readdir(outDir))
    .filter((name) => name.toLowerCase().endsWith("-setup.exe"))
    .sort();
  const legacyWindowsChannelPaths: string[] = [];
  if (winExes.length > 0) {
    const written = await writeLegacyWindowsChannelFilesForDir({
      inDir: outDir,
      outDir,
      version,
      releaseDate: pubDate,
      requiredArches: requireComplete ? REQUIRED_LEGACY_WINDOWS_ARCHES : undefined,
    });
    for (const item of written) {
      legacyWindowsChannelPaths.push(item.outPath);
    }
  } else if (requireComplete) {
    throw new Error(
      `No Windows *-setup.exe installers found in ${outDir} while requireComplete is enabled.`,
    );
  }

  if (requireComplete || latestJsonPath) {
    await verifyAssembledReleaseDir({
      dir: outDir,
      version,
      tag,
      owner,
      repo,
      requireComplete,
      minOriginatingVersion,
    });
  }

  const finalAssets = (await fs.readdir(outDir)).sort();
  return {
    version,
    tag,
    pubDate,
    outDir,
    latestJsonPath,
    legacyMacChannelPath,
    legacyWindowsChannelPaths,
    assets: finalAssets,
    manifest,
  };
}

export async function verifyAssembledReleaseDir(params: {
  dir: string;
  version: string;
  tag: string;
  owner?: string;
  repo?: string;
  requireComplete?: boolean;
  minOriginatingVersion?: string | null;
}): Promise<VerifyAssembledReleaseResult> {
  const dir = path.resolve(params.dir);
  const version = normalizeSemverVersion(params.version);
  const tag = params.tag.trim();
  const owner = (params.owner ?? DEFAULT_GITHUB_OWNER).trim();
  const repo = (params.repo ?? DEFAULT_GITHUB_REPO).trim();
  const requireComplete = params.requireComplete ?? true;
  const minOriginatingVersion =
    params.minOriginatingVersion === undefined
      ? requireComplete
        ? ORIGINATING_ELECTRON_VERSION
        : null
      : params.minOriginatingVersion;

  assertReleaseTagMatchesVersion(tag, version);
  if (minOriginatingVersion) {
    assertCandidateNewerThanOriginating(version, minOriginatingVersion);
  }

  // 1. Verify native Rune feed (`latest.json`) and its referenced payloads + `.sig` files.
  const latestJsonPath = path.join(dir, "latest.json");
  const latestJsonRaw = await fs.readFile(latestJsonPath, "utf8").catch(() => null);
  if (!latestJsonRaw) {
    throw new Error(`Assembled release directory is missing native feed: ${latestJsonPath}`);
  }
  const latestJson = JSON.parse(latestJsonRaw) as LatestJsonManifest;
  validateLatestJsonManifest(latestJson);
  if (normalizeSemverVersion(latestJson.version) !== version) {
    throw new Error(
      `latest.json version "${latestJson.version}" does not match expected version ${version}.`,
    );
  }

  const expectedPlatforms = requireComplete
    ? REQUIRED_BRIDGE_PLATFORM_KEYS
    : (Object.keys(latestJson.platforms) as UpdaterPlatformKey[]);
  const verifiedPlatforms: UpdaterPlatformKey[] = [];

  for (const platformKey of expectedPlatforms) {
    const entry = latestJson.platforms[platformKey];
    if (!entry) {
      throw new Error(`latest.json is missing required platform "${platformKey}".`);
    }
    const parsedUrl = new URL(entry.url);
    const fileName = decodeURIComponent(parsedUrl.pathname.split("/").pop() ?? "");
    const expectedUrl = buildReleaseDownloadUrl({ owner, repo, tag, fileName });
    if (entry.url !== expectedUrl) {
      throw new Error(
        `latest.json URL for "${platformKey}" (${entry.url}) does not resolve to release tag "${tag}" (expected ${expectedUrl}).`,
      );
    }

    const payloadPath = path.join(dir, fileName);
    const payloadStat = await fs.stat(payloadPath).catch(() => null);
    if (!payloadStat?.isFile() || payloadStat.size === 0) {
      throw new Error(
        `latest.json references payload "${fileName}" for "${platformKey}", which is missing or empty in ${dir}.`,
      );
    }

    const sigPath = `${payloadPath}.sig`;
    const sigRaw = await fs.readFile(sigPath, "utf8").catch(() => null);
    if (!sigRaw?.trim()) {
      throw new Error(
        `Missing Minisign signature file "${fileName}.sig" alongside payload for "${platformKey}".`,
      );
    }
    if (sigRaw.trim() !== entry.signature.trim()) {
      throw new Error(
        `Minisign signature mismatch between latest.json and "${fileName}.sig" for "${platformKey}".`,
      );
    }
    verifiedPlatforms.push(platformKey);
  }

  // 2. Verify legacy macOS feed (`latest-mac.yml`) and final ZIP bytes.
  const latestMacPath = path.join(dir, LEGACY_MAC_CHANNEL_FILENAME);
  const latestMacRaw = await fs.readFile(latestMacPath, "utf8").catch(() => null);
  const macZips = {} as Record<MacLegacyArch, string>;
  if (!latestMacRaw) {
    if (requireComplete) {
      throw new Error(`Assembled release directory is missing legacy macOS feed: ${latestMacPath}`);
    }
  } else {
    const macMeta = parseLegacyMacChannelYaml(latestMacRaw);
    validateLegacyMacChannelMetadata(macMeta);
    if (normalizeSemverVersion(macMeta.version) !== version) {
      throw new Error(
        `latest-mac.yml version "${macMeta.version}" does not match expected version ${version}.`,
      );
    }

    for (const fileEntry of macMeta.files) {
      const zipPath = path.join(dir, fileEntry.url);
      const stat = await fs.stat(zipPath).catch(() => null);
      if (!stat?.isFile()) {
        throw new Error(
          `latest-mac.yml references missing macOS ZIP "${fileEntry.url}" in ${dir}.`,
        );
      }
      const actual = await computeFileSha512AndSize(zipPath);
      if (actual.size !== fileEntry.size || actual.sha512 !== fileEntry.sha512) {
        throw new Error(
          `latest-mac.yml digest/size mismatch for "${fileEntry.url}" (expected size=${fileEntry.size} sha512=${fileEntry.sha512}, actual size=${actual.size} sha512=${actual.sha512}).`,
        );
      }
    }

    if (requireComplete) {
      const arm64Selected = selectLegacyMacZipForClient(macMeta, {
        processArch: "arm64",
        isRosetta: false,
        owner,
        repo,
        tag,
      });
      const rosettaSelected = selectLegacyMacZipForClient(macMeta, {
        processArch: "x64",
        isRosetta: true,
        owner,
        repo,
        tag,
      });
      const x64Selected = selectLegacyMacZipForClient(macMeta, {
        processArch: "x64",
        isRosetta: false,
        owner,
        repo,
        tag,
      });
      if (!arm64Selected || !rosettaSelected || !x64Selected) {
        throw new Error(
          `latest-mac.yml failed to resolve required macOS ZIPs for arm64/Rosetta/x64 on ${tag}.`,
        );
      }
      if (arm64Selected.fileName !== rosettaSelected.fileName) {
        throw new Error(
          `Rosetta macOS selection (${rosettaSelected.fileName}) diverged from native arm64 (${arm64Selected.fileName}).`,
        );
      }
      if (arm64Selected.fileName === x64Selected.fileName) {
        throw new Error(
          `macOS arm64 and x64 clients both resolved to the same ZIP (${arm64Selected.fileName}).`,
        );
      }
      macZips.arm64 = arm64Selected.fileName;
      macZips.x64 = x64Selected.fileName;
    } else {
      for (const arch of REQUIRED_LEGACY_MAC_ARCHES) {
        const selected = selectLegacyMacZipForClient(macMeta, {
          processArch: arch,
          isRosetta: false,
          owner,
          repo,
          tag,
        });
        if (selected) {
          macZips[arch] = selected.fileName;
        }
      }
    }
  }

  // 3. Verify legacy Windows feeds (`latest.yml` for x64, `latest-arm64.yml` for arm64) and final `.exe` bytes.
  const legacyWindowsInstallers = {} as Record<WindowsLegacyArch, string>;
  const windowsChannels: ReadonlyArray<{ arch: WindowsLegacyArch; channelFile: string }> = [
    { arch: "x64", channelFile: LEGACY_WINDOWS_X64_CHANNEL_FILENAME },
    { arch: "arm64", channelFile: LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME },
  ];

  for (const { arch, channelFile } of windowsChannels) {
    const channelPath = path.join(dir, channelFile);
    const channelRaw = await fs.readFile(channelPath, "utf8").catch(() => null);
    if (!channelRaw) {
      if (requireComplete) {
        throw new Error(
          `Assembled release directory is missing legacy Windows ${arch} feed: ${channelPath}`,
        );
      }
      continue;
    }
    const meta = parseLegacyWindowsChannelYaml(channelRaw, arch);
    validateLegacyWindowsChannelMetadata(meta, arch);
    if (normalizeSemverVersion(meta.version) !== version) {
      throw new Error(
        `${channelFile} version "${meta.version}" does not match expected version ${version}.`,
      );
    }
    const selected = selectLegacyWindowsInstallerForClient(
      { [channelFile]: meta },
      { arch, tag, owner, repo },
    );
    if (!selected) {
      throw new Error(`${channelFile} did not select a Windows ${arch} installer for ${tag}.`);
    }
    const installerPath = path.join(dir, selected.fileName);
    const stat = await fs.stat(installerPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(
        `${channelFile} references missing Windows installer "${selected.fileName}" in ${dir}.`,
      );
    }
    const actual = await computeFileSha512AndSize(installerPath);
    if (actual.size !== selected.entry.size || actual.sha512 !== selected.entry.sha512) {
      throw new Error(
        `${channelFile} digest/size mismatch for "${selected.fileName}" (expected size=${selected.entry.size} sha512=${selected.entry.sha512}, actual size=${actual.size} sha512=${actual.sha512}).`,
      );
    }
    legacyWindowsInstallers[arch] = selected.fileName;
  }

  return {
    version,
    tag,
    dir,
    latestJsonPlatforms: verifiedPlatforms,
    legacyMacZips: macZips,
    legacyWindowsInstallers,
  };
}

function getFlagValue(argv: readonly string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  const prefix = `${flag}=`;
  const eq = argv.find((arg) => arg.startsWith(prefix));
  return eq ? eq.slice(prefix.length) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(
      [
        "Usage:",
        "  bun scripts/assemble_rune_release.ts assemble --artifacts-dir <dir> --out-dir <dir> --version <semver> --tag <tag> [--owner <owner>] [--repo <repo>] [--pub-date <iso8601>] [--require-complete] [--require-signed] [--min-originating-version <semver>]",
        "  bun scripts/assemble_rune_release.ts verify --dir <dir> --version <semver> --tag <tag> [--owner <owner>] [--repo <repo>] [--require-complete] [--min-originating-version <semver>]",
        "  bun scripts/assemble_rune_release.ts check-version --version <semver> [--tag <tag>] [--min-originating-version <semver>]",
        "  bun scripts/assemble_rune_release.ts next-patch-version --version <semver>",
      ].join("\n"),
    );
    return;
  }

  if (subcommand === "next-patch-version") {
    const version = getFlagValue(args, "--version");
    if (!version) throw new Error("Missing required --version <semver>.");
    console.log(computeNextPatchVersion(version));
    return;
  }

  if (subcommand === "check-version") {
    const version = getFlagValue(args, "--version");
    const tag = getFlagValue(args, "--tag");
    const minOriginating =
      getFlagValue(args, "--min-originating-version") ?? ORIGINATING_ELECTRON_VERSION;
    if (!version) throw new Error("Missing required --version <semver>.");
    if (tag) {
      assertReleaseTagMatchesVersion(tag, version);
    }
    assertCandidateNewerThanOriginating(version, minOriginating);
    console.log(
      `[assemble-release] Version ${normalizeSemverVersion(version)} is valid and newer than originating client ${normalizeSemverVersion(minOriginating)}.`,
    );
    return;
  }

  if (subcommand === "assemble") {
    const artifactsDir = getFlagValue(args, "--artifacts-dir");
    const outDir = getFlagValue(args, "--out-dir");
    const version = getFlagValue(args, "--version");
    const tag = getFlagValue(args, "--tag");
    const owner = getFlagValue(args, "--owner");
    const repo = getFlagValue(args, "--repo");
    const pubDate = getFlagValue(args, "--pub-date");
    const notes = getFlagValue(args, "--notes");
    const requireComplete = args.includes("--require-complete");
    const requireSigned = args.includes("--require-signed");
    const minOriginating = getFlagValue(args, "--min-originating-version");

    if (!artifactsDir) throw new Error("Missing required --artifacts-dir <dir>.");
    if (!outDir) throw new Error("Missing required --out-dir <dir>.");
    if (!version) throw new Error("Missing required --version <semver>.");
    if (!tag) throw new Error("Missing required --tag <tag>.");

    const result = await assembleRuneRelease({
      artifactsDir,
      outDir,
      version,
      tag,
      owner,
      repo,
      pubDate,
      notes,
      requireComplete,
      requireSigned,
      minOriginatingVersion:
        minOriginating ?? (requireComplete ? ORIGINATING_ELECTRON_VERSION : null),
    });
    console.log(
      `[assemble-release] Assembled ${result.tag} (v${result.version}) into ${result.outDir}: ${result.assets.length} asset(s)`,
    );
    return;
  }

  if (subcommand === "verify") {
    const dir = getFlagValue(args, "--dir");
    const version = getFlagValue(args, "--version");
    const tag = getFlagValue(args, "--tag");
    const owner = getFlagValue(args, "--owner");
    const repo = getFlagValue(args, "--repo");
    const requireComplete = !args.includes("--allow-partial");
    const minOriginating = getFlagValue(args, "--min-originating-version");

    if (!dir) throw new Error("Missing required --dir <dir>.");
    if (!version) throw new Error("Missing required --version <semver>.");
    if (!tag) throw new Error("Missing required --tag <tag>.");

    const result = await verifyAssembledReleaseDir({
      dir,
      version,
      tag,
      owner,
      repo,
      requireComplete,
      minOriginatingVersion:
        minOriginating ?? (requireComplete ? ORIGINATING_ELECTRON_VERSION : null),
    });
    console.log(
      `[assemble-release] Verified ${result.tag} (v${result.version}): platforms=[${result.latestJsonPlatforms.join(", ")}], mac=[${Object.values(result.legacyMacZips).join(", ")}], win=[${Object.values(result.legacyWindowsInstallers).join(", ")}]`,
    );
    return;
  }

  throw new Error(
    `Unknown subcommand "${subcommand}". Expected "assemble", "verify", "check-version", or "next-patch-version".`,
  );
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
