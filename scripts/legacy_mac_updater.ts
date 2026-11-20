import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/scratchRoots";
import { isSidecarManifest, SIDECAR_MANIFEST_NAME } from "../src/platform/sidecar";
import { normalizeSemverVersion } from "./desktop_rune_release_manifest";
import { pathExists, resolveRustCompileTarget } from "./releaseBuildUtils";

export const LEGACY_MAC_CHANNEL_FILENAME = "latest-mac.yml";
export const EXPECTED_MAC_BUNDLE_NAME = "Cowork.app";
export const EXPECTED_MAC_BUNDLE_ID = "com.cowork.desktop";
export const EXPECTED_MAC_PRODUCT_NAME = "Cowork";
export const EXPECTED_MAC_EXECUTABLE_NAME = "Cowork";
export const EXPECTED_MAC_MIN_SYSTEM_VERSION = "12.0";

export type MacLegacyArch = "arm64" | "x64";

export interface LegacyMacZipFileEntry {
  url: string;
  sha512: string;
  size: number;
}

export interface LegacyMacChannelMetadata {
  version: string;
  files: LegacyMacZipFileEntry[];
  path: string;
  sha512: string;
  releaseDate: string;
}

export interface MacBundleVerificationResult {
  appPath: string;
  bundleId: string;
  bundleName: string;
  displayName: string;
  executableName: string;
  version: string;
  minimumSystemVersion: string;
  mainExecutableArchs: MacLegacyArch[];
  sidecarFileName: string;
  sidecarArchs: MacLegacyArch[];
}

export interface MacProducerVerificationResult {
  arch: MacLegacyArch;
  version: string;
  appBundle: MacBundleVerificationResult;
  zipExtractedBundle: MacBundleVerificationResult;
  zipPath: string;
  zipSha512: string;
  zipSize: number;
  updaterTarGzPath?: string;
  latestMacYmlPath?: string;
}

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_ASSET_BASENAME_RE = /^[A-Za-z0-9._-]+$/;

const MACHO_MAGIC_64_LE = 0xfeedfacf;
const MACHO_MAGIC_64_BE = 0xcffaedfe;
const MACHO_FAT_MAGIC_BE = 0xcafebabe;
const MACHO_FAT_CIGAM_LE = 0xbebafeca;
const MACHO_FAT_MAGIC_64_BE = 0xcafebabf;
const MACHO_FAT_CIGAM_64_LE = 0xbfbafeca;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function normalizeMacLegacyArch(raw: string): MacLegacyArch {
  switch (raw.trim().toLowerCase()) {
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x64":
    case "x86_64":
    case "amd64":
      return "x64";
    default:
      throw new Error(`Unsupported macOS architecture "${raw}". Expected arm64 or x64.`);
  }
}

export function resolveLegacyMacZipName(arch: string, version: string): string {
  const normVersion = normalizeSemverVersion(version);
  const normArch = normalizeMacLegacyArch(arch);
  return `${EXPECTED_MAC_PRODUCT_NAME}_${normVersion}_${normArch}-mac.zip`;
}

export function resolveMacTarGzName(arch: string, version: string): string {
  const normVersion = normalizeSemverVersion(version);
  const macArch = normalizeMacLegacyArch(arch) === "arm64" ? "aarch64" : "x64";
  return `${EXPECTED_MAC_PRODUCT_NAME}_${normVersion}_${macArch}.app.tar.gz`;
}

export function resolveMacDmgName(arch: string, version: string): string {
  const normVersion = normalizeSemverVersion(version);
  const macArch = normalizeMacLegacyArch(arch) === "arm64" ? "aarch64" : "x64";
  return `${EXPECTED_MAC_PRODUCT_NAME}_${normVersion}_${macArch}.dmg`;
}

export function classifyLegacyMacZipArch(fileName: string): MacLegacyArch {
  const trimmed = fileName.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    !SAFE_ASSET_BASENAME_RE.test(trimmed)
  ) {
    throw new Error(
      `Invalid macOS ZIP basename "${fileName}". Expected a safe GitHub release filename without spaces or path separators.`,
    );
  }
  const lower = trimmed.toLowerCase();
  if (!lower.endsWith(".zip")) {
    throw new Error(
      `Expected a .zip filename for macOS legacy updater channel, got "${fileName}".`,
    );
  }
  if (lower.includes("arm64")) {
    return "arm64";
  }
  if (lower.includes("aarch64")) {
    throw new Error(
      `macOS legacy ZIP "${fileName}" uses "aarch64" instead of "arm64"; electron-updater MacUpdater.filterFilesForArch requires "arm64" in the filename.`,
    );
  }
  if (lower.includes("x64") || lower.includes("x86_64")) {
    return "x64";
  }
  throw new Error(
    `Unable to classify macOS architecture from ZIP filename "${fileName}". Expected "arm64" or "x64" marker.`,
  );
}

export async function computeSha512Base64AndSize(
  filePath: string,
): Promise<{ sha512: string; size: number }> {
  const bytes = await fs.readFile(filePath);
  if (bytes.length === 0) {
    throw new Error(`Release artifact is empty: ${filePath}`);
  }
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  return { sha512, size: bytes.length };
}

export async function resolveLegacyMacZipMetadataFromFile(zipPath: string): Promise<{
  arch: MacLegacyArch;
  entry: LegacyMacZipFileEntry;
}> {
  const fileName = path.basename(zipPath);
  const arch = classifyLegacyMacZipArch(fileName);
  const { sha512, size } = await computeSha512Base64AndSize(zipPath);
  return {
    arch,
    entry: {
      url: fileName,
      sha512,
      size,
    },
  };
}

function isValidSha512Base64(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 64 && decoded.toString("base64") === value;
}

export function validateLegacyMacChannelMetadata(metadata: LegacyMacChannelMetadata): void {
  const version = normalizeSemverVersion(metadata.version);
  if (metadata.version !== version) {
    throw new Error(
      `latest-mac.yml version "${metadata.version}" must be normalized semver ("${version}").`,
    );
  }
  if (typeof metadata.releaseDate !== "string" || !RFC3339_RE.test(metadata.releaseDate)) {
    throw new Error(`Invalid RFC 3339 releaseDate in latest-mac.yml: "${metadata.releaseDate}".`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error("latest-mac.yml must include at least one macOS ZIP file entry.");
  }

  const seenArches = new Set<MacLegacyArch>();
  for (const file of metadata.files) {
    const arch = classifyLegacyMacZipArch(file.url);
    if (seenArches.has(arch)) {
      throw new Error(`Duplicate macOS architecture "${arch}" in latest-mac.yml.`);
    }
    seenArches.add(arch);
    if (!isValidSha512Base64(file.sha512)) {
      throw new Error(`Invalid base64 SHA-512 digest for "${file.url}" in latest-mac.yml.`);
    }
    if (!Number.isInteger(file.size) || file.size <= 0) {
      throw new Error(
        `Invalid byte size (${String(file.size)}) for "${file.url}" in latest-mac.yml.`,
      );
    }
  }

  const primary = metadata.files[0];
  if (metadata.path !== primary.url) {
    throw new Error(
      `latest-mac.yml top-level path "${metadata.path}" must match primary file "${primary.url}".`,
    );
  }
  if (metadata.sha512 !== primary.sha512) {
    throw new Error("latest-mac.yml top-level sha512 must match primary file sha512.");
  }
}

export async function buildLegacyMacChannelMetadata(params: {
  version: string;
  zipPaths: readonly string[];
  releaseDate?: string;
  requiredArches?: readonly MacLegacyArch[];
}): Promise<LegacyMacChannelMetadata> {
  const version = normalizeSemverVersion(params.version);
  const releaseDate = (params.releaseDate ?? new Date().toISOString()).trim();
  if (!RFC3339_RE.test(releaseDate)) {
    throw new Error(`Invalid RFC 3339 releaseDate: "${releaseDate}".`);
  }
  if (params.zipPaths.length === 0) {
    throw new Error("Cannot generate latest-mac.yml without at least one final macOS ZIP file.");
  }

  const byArch = new Map<MacLegacyArch, LegacyMacZipFileEntry>();
  for (const zipPath of params.zipPaths) {
    const { arch, entry } = await resolveLegacyMacZipMetadataFromFile(zipPath);
    if (!entry.url.includes(version)) {
      throw new Error(
        `macOS ZIP filename "${entry.url}" does not match expected release version "${version}".`,
      );
    }
    if (byArch.has(arch)) {
      throw new Error(
        `Duplicate macOS ZIP for architecture "${arch}": "${entry.url}" and "${byArch.get(arch)?.url}".`,
      );
    }
    byArch.set(arch, entry);
  }

  for (const reqArch of params.requiredArches ?? []) {
    if (!byArch.has(reqArch)) {
      throw new Error(
        `Missing required macOS "${reqArch}" ZIP for ${LEGACY_MAC_CHANNEL_FILENAME} (found: ${Array.from(byArch.keys()).join(", ") || "none"}).`,
      );
    }
  }

  const orderedArches: MacLegacyArch[] = ["arm64", "x64"];
  const files: LegacyMacZipFileEntry[] = [];
  for (const arch of orderedArches) {
    const entry = byArch.get(arch);
    if (entry) files.push(entry);
  }

  const primary = files[0];
  if (!primary) {
    throw new Error("No valid macOS ZIP entries resolved for latest-mac.yml.");
  }

  const metadata: LegacyMacChannelMetadata = {
    version,
    files,
    path: primary.url,
    sha512: primary.sha512,
    releaseDate,
  };
  validateLegacyMacChannelMetadata(metadata);
  return metadata;
}

export function serializeLegacyMacChannelYaml(metadata: LegacyMacChannelMetadata): string {
  validateLegacyMacChannelMetadata(metadata);
  const lines: string[] = [`version: ${metadata.version}`, "files:"];
  for (const file of metadata.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }
  lines.push(`path: ${metadata.path}`);
  lines.push(`sha512: ${metadata.sha512}`);
  lines.push(`releaseDate: '${metadata.releaseDate}'`);
  return `${lines.join("\n")}\n`;
}

export function parseLegacyMacChannelYaml(rawYaml: string): LegacyMacChannelMetadata {
  const parsed = Bun.YAML.parse(rawYaml) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Failed to parse latest-mac.yml: expected a YAML mapping.");
  }
  const filesRaw = parsed.files;
  if (!Array.isArray(filesRaw)) {
    throw new Error("Malformed latest-mac.yml: missing files list.");
  }
  const files: LegacyMacZipFileEntry[] = filesRaw.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Malformed files[${idx}] entry in latest-mac.yml.`);
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.url !== "string" ||
      typeof record.sha512 !== "string" ||
      typeof record.size !== "number"
    ) {
      throw new Error(`Malformed files[${idx}] fields in latest-mac.yml.`);
    }
    return {
      url: record.url,
      sha512: record.sha512,
      size: record.size,
    };
  });
  if (
    typeof parsed.version !== "string" ||
    typeof parsed.path !== "string" ||
    typeof parsed.sha512 !== "string" ||
    typeof parsed.releaseDate !== "string"
  ) {
    throw new Error(
      "Malformed latest-mac.yml: missing version, path, sha512, or string releaseDate.",
    );
  }
  const metadata: LegacyMacChannelMetadata = {
    version: parsed.version,
    files,
    path: parsed.path,
    sha512: parsed.sha512,
    releaseDate: parsed.releaseDate,
  };
  validateLegacyMacChannelMetadata(metadata);
  return metadata;
}

/**
 * Mirrors historical electron-updater@6.8.9 `GitHubProvider.resolveFiles` +
 * `MacUpdater.filterFilesForArch` + `Provider.findFile(files, "zip", ["pkg", "dmg"])`.
 */
export function selectLegacyMacZipForClient(
  metadata: LegacyMacChannelMetadata,
  client: {
    processArch: MacLegacyArch;
    isRosetta?: boolean;
    owner?: string;
    repo?: string;
    tag: string;
  },
): { url: string; fileName: string; entry: LegacyMacZipFileEntry } | null {
  const owner = client.owner ?? "mweinbach";
  const repo = client.repo ?? "agent-coworker";
  const isArm64Mac = client.processArch === "arm64" || Boolean(client.isRosetta);

  const resolved = metadata.files.map((info) => {
    const safePath = info.url.replace(/ /g, "-");
    const url = new URL(
      `/${owner}/${repo}/releases/download/${client.tag}/${safePath}`,
      "https://github.com",
    );
    return { url, info };
  });

  const isArm64File = (item: { url: URL; info: LegacyMacZipFileEntry }) =>
    item.url.pathname.includes("arm64") || item.info.url.includes("arm64");

  const archFiltered =
    isArm64Mac && resolved.some(isArm64File)
      ? resolved.filter((item) => isArm64Mac === isArm64File(item))
      : resolved.filter((item) => !isArm64File(item));

  if (archFiltered.length === 0) {
    return null;
  }

  const zipFiles = archFiltered.filter((item) => item.url.pathname.toLowerCase().endsWith(".zip"));
  const chosen =
    zipFiles.find((item) =>
      [item.url.pathname, item.info.url].some((candidate) =>
        candidate.includes(client.processArch),
      ),
    ) ?? zipFiles[0];

  if (!chosen) {
    return null;
  }

  return {
    url: chosen.url.href,
    fileName: chosen.info.url,
    entry: chosen.info,
  };
}

export async function writeLegacyMacChannelFile(params: {
  version: string;
  zipPaths: readonly string[];
  outPath: string;
  releaseDate?: string;
  requiredArches?: readonly MacLegacyArch[];
}): Promise<{ metadata: LegacyMacChannelMetadata; yaml: string }> {
  const metadata = await buildLegacyMacChannelMetadata({
    version: params.version,
    zipPaths: params.zipPaths,
    releaseDate: params.releaseDate,
    requiredArches: params.requiredArches,
  });
  const yaml = serializeLegacyMacChannelYaml(metadata);
  await fs.mkdir(path.dirname(params.outPath), { recursive: true });
  await fs.writeFile(params.outPath, yaml, "utf8");
  return { metadata, yaml };
}

function cpuTypeToMacArch(cpuType: number): MacLegacyArch | null {
  if (cpuType === CPU_TYPE_ARM64) return "arm64";
  if (cpuType === CPU_TYPE_X86_64) return "x64";
  return null;
}

export async function inspectMachOArchs(binaryPath: string): Promise<MacLegacyArch[]> {
  const handle = await fs.open(binaryPath, "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 8) {
      throw new Error(`File too small to be a Mach-O binary: ${binaryPath}`);
    }
    const magicBE = header.readUInt32BE(0);
    const magicLE = header.readUInt32LE(0);

    if (magicLE === MACHO_MAGIC_64_LE) {
      const arch = cpuTypeToMacArch(header.readUInt32LE(4));
      if (!arch) {
        throw new Error(`Unsupported Mach-O 64-bit CPU type in ${binaryPath}.`);
      }
      return [arch];
    }
    if (magicBE === MACHO_MAGIC_64_BE) {
      const arch = cpuTypeToMacArch(header.readUInt32BE(4));
      if (!arch) {
        throw new Error(`Unsupported Mach-O 64-bit CPU type in ${binaryPath}.`);
      }
      return [arch];
    }
    if (magicBE === MACHO_FAT_MAGIC_BE || magicBE === MACHO_FAT_CIGAM_LE) {
      const nfat = header.readUInt32BE(4);
      const archs = new Set<MacLegacyArch>();
      for (let i = 0; i < nfat; i += 1) {
        const offset = 8 + i * 20;
        if (offset + 4 > bytesRead) break;
        const arch = cpuTypeToMacArch(header.readUInt32BE(offset));
        if (arch) archs.add(arch);
      }
      if (archs.size === 0) {
        throw new Error(`No supported macOS architectures found in fat Mach-O ${binaryPath}.`);
      }
      return Array.from(archs);
    }
    if (magicBE === MACHO_FAT_MAGIC_64_BE || magicBE === MACHO_FAT_CIGAM_64_LE) {
      const nfat = header.readUInt32BE(4);
      const archs = new Set<MacLegacyArch>();
      for (let i = 0; i < nfat; i += 1) {
        const offset = 8 + i * 32;
        if (offset + 4 > bytesRead) break;
        const arch = cpuTypeToMacArch(header.readUInt32BE(offset));
        if (arch) archs.add(arch);
      }
      if (archs.size === 0) {
        throw new Error(
          `No supported macOS architectures found in 64-bit fat Mach-O ${binaryPath}.`,
        );
      }
      return Array.from(archs);
    }
    throw new Error(
      `Not a recognized 64-bit Mach-O binary: ${binaryPath} (magic=0x${magicBE.toString(16)}).`,
    );
  } finally {
    await handle.close();
  }
}

function unescapeXmlEntities(raw: string): string {
  return raw
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parsePlistXmlStringValues(plistXml: string): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  const pairRe = /<key>\s*([^<]+?)\s*<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (const match of plistXml.matchAll(pairRe)) {
    const key = unescapeXmlEntities(match[1].trim());
    const value = unescapeXmlEntities(match[2].trim());
    result[key] = value;
  }
  return result;
}

export async function verifyMacAppBundle(params: {
  appPath: string;
  expectedVersion: string;
  expectedArch: MacLegacyArch;
  expectedBundleId?: string;
  expectedProductName?: string;
  expectedExecutableName?: string;
  expectedMinSystemVersion?: string;
}): Promise<MacBundleVerificationResult> {
  const expectedVersion = normalizeSemverVersion(params.expectedVersion);
  const expectedArch = normalizeMacLegacyArch(params.expectedArch);
  const expectedBundleId = params.expectedBundleId ?? EXPECTED_MAC_BUNDLE_ID;
  const expectedProductName = params.expectedProductName ?? EXPECTED_MAC_PRODUCT_NAME;
  const expectedExecutableName = params.expectedExecutableName ?? EXPECTED_MAC_EXECUTABLE_NAME;
  const expectedMinSystemVersion =
    params.expectedMinSystemVersion ?? EXPECTED_MAC_MIN_SYSTEM_VERSION;

  if (path.basename(params.appPath) !== `${expectedProductName}.app`) {
    throw new Error(
      `Expected macOS bundle named "${expectedProductName}.app", got "${path.basename(params.appPath)}".`,
    );
  }
  const appStat = await fs.stat(params.appPath).catch(() => null);
  if (!appStat?.isDirectory()) {
    throw new Error(`Missing macOS app bundle directory: ${params.appPath}`);
  }

  const infoPlistPath = path.join(params.appPath, "Contents", "Info.plist");
  if (!(await pathExists(infoPlistPath))) {
    throw new Error(`Missing Info.plist inside bundle: ${infoPlistPath}`);
  }
  const plistValues = parsePlistXmlStringValues(await fs.readFile(infoPlistPath, "utf8"));

  const bundleId = plistValues.CFBundleIdentifier ?? "";
  const bundleName = plistValues.CFBundleName ?? "";
  const displayName = plistValues.CFBundleDisplayName ?? "";
  const executableName = plistValues.CFBundleExecutable ?? "";
  const bundleVersion = plistValues.CFBundleShortVersionString ?? "";
  const minimumSystemVersion = plistValues.LSMinimumSystemVersion ?? "";

  if (bundleId !== expectedBundleId) {
    throw new Error(
      `Unexpected CFBundleIdentifier in ${infoPlistPath}: "${bundleId}" (expected "${expectedBundleId}").`,
    );
  }
  if (bundleName !== expectedProductName) {
    throw new Error(
      `Unexpected CFBundleName in ${infoPlistPath}: "${bundleName}" (expected "${expectedProductName}").`,
    );
  }
  if (displayName !== expectedProductName) {
    throw new Error(
      `Unexpected CFBundleDisplayName in ${infoPlistPath}: "${displayName}" (expected "${expectedProductName}").`,
    );
  }
  if (executableName !== expectedExecutableName) {
    throw new Error(
      `Unexpected CFBundleExecutable in ${infoPlistPath}: "${executableName}" (expected "${expectedExecutableName}").`,
    );
  }
  if (bundleVersion !== expectedVersion) {
    throw new Error(
      `Unexpected CFBundleShortVersionString in ${infoPlistPath}: "${bundleVersion}" (expected "${expectedVersion}").`,
    );
  }
  if (minimumSystemVersion !== expectedMinSystemVersion) {
    throw new Error(
      `Unexpected LSMinimumSystemVersion in ${infoPlistPath}: "${minimumSystemVersion}" (expected "${expectedMinSystemVersion}").`,
    );
  }

  const macOsDir = path.join(params.appPath, "Contents", "MacOS");
  const mainExePath = path.join(macOsDir, expectedExecutableName);
  const exeStat = await fs.stat(mainExePath).catch(() => null);
  if (!exeStat?.isFile()) {
    throw new Error(`Missing expected macOS main executable: ${mainExePath}`);
  }
  if ((exeStat.mode & 0o111) === 0) {
    throw new Error(`macOS main executable is not marked executable: ${mainExePath}`);
  }
  if (expectedExecutableName !== "cowork-desktop") {
    const staleExePath = path.join(macOsDir, "cowork-desktop");
    if (await pathExists(staleExePath)) {
      throw new Error(
        `Unexpected legacy executable name left in macOS bundle alongside ${expectedExecutableName}: ${staleExePath}`,
      );
    }
  }

  const mainExecutableArchs = await inspectMachOArchs(mainExePath);
  if (mainExecutableArchs.length !== 1 || mainExecutableArchs[0] !== expectedArch) {
    throw new Error(
      `Main executable ${mainExePath} has Mach-O arch [${mainExecutableArchs.join(", ")}], expected [${expectedArch}].`,
    );
  }

  const rustTarget = resolveRustCompileTarget("darwin", expectedArch);
  const sidecarFileName = `cowork-server-${rustTarget}`;
  const resourcesDir = path.join(params.appPath, "Contents", "Resources");
  const sidecarPath = path.join(resourcesDir, "binaries", sidecarFileName);
  const sidecarStat = await fs.stat(sidecarPath).catch(() => null);
  if (!sidecarStat?.isFile()) {
    throw new Error(`Missing bundled macOS sidecar executable: ${sidecarPath}`);
  }
  if ((sidecarStat.mode & 0o111) === 0) {
    throw new Error(`Bundled macOS sidecar is not executable: ${sidecarPath}`);
  }
  const sidecarArchs = await inspectMachOArchs(sidecarPath);
  if (sidecarArchs.length !== 1 || sidecarArchs[0] !== expectedArch) {
    throw new Error(
      `Bundled sidecar ${sidecarPath} has Mach-O arch [${sidecarArchs.join(", ")}], expected [${expectedArch}].`,
    );
  }

  const sidecarManifestPath = path.join(resourcesDir, "binaries", SIDECAR_MANIFEST_NAME);
  if (!(await pathExists(sidecarManifestPath))) {
    throw new Error(`Missing bundled sidecar manifest: ${sidecarManifestPath}`);
  }
  const parsedManifest: unknown = JSON.parse(await fs.readFile(sidecarManifestPath, "utf8"));
  if (
    !isSidecarManifest(parsedManifest) ||
    parsedManifest.platform !== "darwin" ||
    parsedManifest.arch !== expectedArch ||
    parsedManifest.targetTriple !== rustTarget ||
    parsedManifest.launch.path !== sidecarFileName
  ) {
    throw new Error(
      `Bundled sidecar manifest ${sidecarManifestPath} does not match darwin/${expectedArch} (${sidecarFileName}).`,
    );
  }

  for (const requiredRel of [
    "dist/prompts",
    "dist/config",
    "dist/skills",
    "dist/workflows",
    "tray/icon.png",
  ]) {
    const fullPath = path.join(resourcesDir, requiredRel);
    if (!(await pathExists(fullPath))) {
      throw new Error(`Missing required bundled macOS resource: ${fullPath}`);
    }
  }

  return {
    appPath: params.appPath,
    bundleId,
    bundleName,
    displayName,
    executableName,
    version: bundleVersion,
    minimumSystemVersion,
    mainExecutableArchs,
    sidecarFileName,
    sidecarArchs,
  };
}

async function execCapture(
  command: string[],
  options: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function verifyMacCodeSignatureAndNotarization(params: {
  appPath: string;
  dmgPath?: string;
  requireDeveloperId: boolean;
  requireNotarization: boolean;
  expectedBundleId?: string;
}): Promise<void> {
  if (hostPlatform() !== "darwin") {
    throw new Error("macOS codesign/notarization verification requires a macOS host.");
  }
  const expectedBundleId = params.expectedBundleId ?? EXPECTED_MAC_BUNDLE_ID;

  const display = await execCapture(["codesign", "-dvvv", params.appPath]);
  const displayOut = `${display.stdout}\n${display.stderr}`;
  if (display.code !== 0) {
    throw new Error(`codesign -dvvv failed for ${params.appPath}:\n${displayOut}`);
  }
  if (!displayOut.includes(`Identifier=${expectedBundleId}`)) {
    throw new Error(
      `Signed bundle ${params.appPath} does not declare Identifier=${expectedBundleId}:\n${displayOut}`,
    );
  }
  if (params.requireDeveloperId && !displayOut.includes("Developer ID Application")) {
    throw new Error(
      `Expected a Developer ID Application signature on ${params.appPath}:\n${displayOut}`,
    );
  }

  const reqResult = await execCapture(["codesign", "-dr", "-", params.appPath]);
  const reqOut = `${reqResult.stdout}\n${reqResult.stderr}`;
  if (reqResult.code !== 0 || !reqOut.includes(`identifier "${expectedBundleId}"`)) {
    throw new Error(
      `Signed bundle ${params.appPath} designated requirement does not match identifier "${expectedBundleId}":\n${reqOut}`,
    );
  }

  const verifyResult = await execCapture([
    "codesign",
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    params.appPath,
  ]);
  if (verifyResult.code !== 0) {
    throw new Error(
      `codesign --verify --deep --strict failed for ${params.appPath}:\n${verifyResult.stdout}\n${verifyResult.stderr}`,
    );
  }

  if (params.requireNotarization) {
    const appStaple = await execCapture(["xcrun", "stapler", "validate", params.appPath]);
    if (appStaple.code !== 0) {
      throw new Error(
        `xcrun stapler validate failed for ${params.appPath}:\n${appStaple.stdout}\n${appStaple.stderr}`,
      );
    }

    if (params.dmgPath) {
      const dmgStaple = await execCapture(["xcrun", "stapler", "validate", params.dmgPath]);
      if (dmgStaple.code !== 0) {
        throw new Error(
          `xcrun stapler validate failed for ${params.dmgPath}:\n${dmgStaple.stdout}\n${dmgStaple.stderr}`,
        );
      }
    }

    const spctl = await execCapture([
      "spctl",
      "--assess",
      "--type",
      "exec",
      "--verbose=4",
      params.appPath,
    ]);
    if (spctl.code !== 0) {
      throw new Error(
        `spctl Gatekeeper assessment failed for ${params.appPath}:\n${spctl.stdout}\n${spctl.stderr}`,
      );
    }
  }
}

function readNullTerminatedAscii(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const zeroIdx = slice.indexOf(0);
  return (zeroIdx === -1 ? slice : slice.subarray(0, zeroIdx)).toString("utf8");
}

function parseTarOctal(buf: Buffer, start: number, length: number): number {
  const raw = readNullTerminatedAscii(buf, start, length).trim();
  if (!raw) return 0;
  return Number.parseInt(raw, 8);
}

function parsePaxPathOverride(payload: Buffer): string | undefined {
  const text = payload.toString("utf8");
  let offset = 0;
  while (offset < text.length) {
    const spaceIdx = text.indexOf(" ", offset);
    if (spaceIdx === -1) break;
    const len = Number.parseInt(text.slice(offset, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(spaceIdx + 1, offset + len).replace(/\n$/, "");
    if (record.startsWith("path=")) {
      return record.slice("path=".length);
    }
    offset += len;
  }
  return undefined;
}

export async function listRawTarGzEntries(tarGzPath: string): Promise<string[]> {
  const compressed = await fs.readFile(tarGzPath);
  const raw = gunzipSync(compressed);
  const entries: string[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;
  let pendingPaxPath: string | undefined;

  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const nameField = readNullTerminatedAscii(header, 0, 100);
    const size = parseTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const prefix = readNullTerminatedAscii(header, 345, 155);
    offset += 512;

    const dataSlice = raw.subarray(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    if (typeFlag === "L") {
      pendingLongName = dataSlice.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeFlag === "x") {
      pendingPaxPath = parsePaxPathOverride(dataSlice);
      continue;
    }
    if (typeFlag === "g") {
      continue;
    }

    const fullName =
      pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
    pendingLongName = undefined;
    pendingPaxPath = undefined;
    if (fullName) {
      entries.push(fullName);
    }
  }

  return entries;
}

export async function verifyMacUpdaterTarGz(tarGzPath: string): Promise<void> {
  if (!(await pathExists(tarGzPath))) {
    throw new Error(`Missing Rune macOS updater archive: ${tarGzPath}`);
  }
  const entries = await listRawTarGzEntries(tarGzPath);
  if (entries.length === 0) {
    throw new Error(`Rune macOS updater archive is empty: ${tarGzPath}`);
  }

  let hasExecutable = false;
  let hasInfoPlist = false;
  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.some((part) => part.startsWith("._"))) {
      throw new Error(
        `Rune macOS updater archive ${tarGzPath} contains AppleDouble metadata entry "${entry}" (re-run tar with COPYFILE_DISABLE=1).`,
      );
    }
    if (parts[0] !== EXPECTED_MAC_BUNDLE_NAME) {
      throw new Error(
        `Rune macOS updater archive ${tarGzPath} has unexpected top-level entry "${parts[0]}" (expected "${EXPECTED_MAC_BUNDLE_NAME}").`,
      );
    }
    if (
      normalized === `${EXPECTED_MAC_BUNDLE_NAME}/Contents/MacOS/${EXPECTED_MAC_EXECUTABLE_NAME}`
    ) {
      hasExecutable = true;
    }
    if (normalized === `${EXPECTED_MAC_BUNDLE_NAME}/Contents/Info.plist`) {
      hasInfoPlist = true;
    }
  }

  if (!hasExecutable || !hasInfoPlist) {
    throw new Error(
      `Rune macOS updater archive ${tarGzPath} is missing ${EXPECTED_MAC_BUNDLE_NAME}/Contents/MacOS/${EXPECTED_MAC_EXECUTABLE_NAME} or Info.plist.`,
    );
  }
}

export async function verifyMacReleaseOutputs(params: {
  outDir: string;
  version: string;
  arch: MacLegacyArch;
  requireSigned?: boolean;
  requireNotarized?: boolean;
  requireUpdaterTarGz?: boolean;
  requireDmg?: boolean;
  verifyLatestMacYmlPath?: string;
}): Promise<MacProducerVerificationResult> {
  const version = normalizeSemverVersion(params.version);
  const arch = normalizeMacLegacyArch(params.arch);
  const appPath = path.join(params.outDir, EXPECTED_MAC_BUNDLE_NAME);
  const zipName = resolveLegacyMacZipName(arch, version);
  const zipPath = path.join(params.outDir, zipName);
  const dmgPath = path.join(params.outDir, resolveMacDmgName(arch, version));
  const tarGzPath = path.join(params.outDir, resolveMacTarGzName(arch, version));

  const appBundle = await verifyMacAppBundle({
    appPath,
    expectedVersion: version,
    expectedArch: arch,
  });

  if (params.requireDmg && !(await pathExists(dmgPath))) {
    throw new Error(`Missing expected macOS DMG: ${dmgPath}`);
  }

  if (!(await pathExists(zipPath))) {
    throw new Error(`Missing expected macOS full ZIP: ${zipPath}`);
  }
  const classifiedArch = classifyLegacyMacZipArch(zipName);
  if (classifiedArch !== arch) {
    throw new Error(
      `ZIP basename "${zipName}" classified as "${classifiedArch}", expected "${arch}".`,
    );
  }

  const { sha512: zipSha512, size: zipSize } = await computeSha512Base64AndSize(zipPath);

  const requireUpdaterTarGz = params.requireUpdaterTarGz ?? true;
  if (requireUpdaterTarGz) {
    await verifyMacUpdaterTarGz(tarGzPath);
  }

  if (params.requireSigned) {
    await verifyMacCodeSignatureAndNotarization({
      appPath,
      dmgPath: (await pathExists(dmgPath)) ? dmgPath : undefined,
      requireDeveloperId: true,
      requireNotarization: Boolean(params.requireNotarized),
    });
  }

  const extractParent = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", "cowork-mac-zip-verify-"),
  );
  let zipExtractedBundle: MacBundleVerificationResult;
  try {
    const extractCmd =
      hostPlatform() === "darwin"
        ? ["ditto", "-x", "-k", zipPath, extractParent]
        : ["unzip", "-q", zipPath, "-d", extractParent];
    const extractRes = await execCapture(extractCmd);
    if (extractRes.code !== 0) {
      throw new Error(
        `Failed to extract macOS ZIP ${zipPath}:\n${extractRes.stdout}\n${extractRes.stderr}`,
      );
    }

    const topEntries = (await fs.readdir(extractParent)).filter((name) => name !== "__MACOSX");
    if (topEntries.length !== 1 || topEntries[0] !== EXPECTED_MAC_BUNDLE_NAME) {
      throw new Error(
        `Extracted macOS ZIP ${zipPath} must contain only "${EXPECTED_MAC_BUNDLE_NAME}" at top level (found: ${topEntries.join(", ") || "none"}).`,
      );
    }

    const extractedAppPath = path.join(extractParent, EXPECTED_MAC_BUNDLE_NAME);
    zipExtractedBundle = await verifyMacAppBundle({
      appPath: extractedAppPath,
      expectedVersion: version,
      expectedArch: arch,
    });

    if (params.requireSigned) {
      await verifyMacCodeSignatureAndNotarization({
        appPath: extractedAppPath,
        requireDeveloperId: true,
        requireNotarization: Boolean(params.requireNotarized),
      });
    }
  } finally {
    await fs.rm(extractParent, { recursive: true, force: true });
  }

  const latestMacYmlPath =
    params.verifyLatestMacYmlPath ??
    ((await pathExists(path.join(params.outDir, LEGACY_MAC_CHANNEL_FILENAME)))
      ? path.join(params.outDir, LEGACY_MAC_CHANNEL_FILENAME)
      : undefined);

  if (latestMacYmlPath) {
    const parsed = parseLegacyMacChannelYaml(await fs.readFile(latestMacYmlPath, "utf8"));
    if (parsed.version !== version) {
      throw new Error(
        `latest-mac.yml version "${parsed.version}" does not match expected version "${version}".`,
      );
    }
    const selected = selectLegacyMacZipForClient(parsed, {
      processArch: arch,
      isRosetta: false,
      tag: `v${version}`,
    });
    if (!selected) {
      throw new Error(
        `Historical macOS updater could not select a ZIP for arch "${arch}" from ${latestMacYmlPath}.`,
      );
    }
    if (selected.fileName !== zipName) {
      throw new Error(
        `Historical macOS updater selected "${selected.fileName}" for "${arch}", expected "${zipName}".`,
      );
    }
    if (selected.entry.sha512 !== zipSha512) {
      throw new Error(
        `latest-mac.yml sha512 mismatch for "${zipName}": metadata has "${selected.entry.sha512}", final bytes have "${zipSha512}".`,
      );
    }
    if (selected.entry.size !== zipSize) {
      throw new Error(
        `latest-mac.yml size mismatch for "${zipName}": metadata has ${selected.entry.size}, final bytes have ${zipSize}.`,
      );
    }
  }

  return {
    arch,
    version,
    appBundle,
    zipExtractedBundle,
    zipPath,
    zipSha512,
    zipSize,
    updaterTarGzPath: requireUpdaterTarGz ? tarGzPath : undefined,
    latestMacYmlPath,
  };
}

export async function collectMacZipFilesInDir(inDir: string): Promise<string[]> {
  const entries = await fs.readdir(inDir, { withFileTypes: true });
  const zipPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (lower.endsWith("-mac.zip")) {
      zipPaths.push(path.join(inDir, entry.name));
    }
  }
  return zipPaths.sort();
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
        "  bun scripts/legacy_mac_updater.ts generate --in-dir <dir> --version <semver> [--out <latest-mac.yml>] [--pub-date <iso8601>] [--require-arches arm64,x64]",
        "  bun scripts/legacy_mac_updater.ts verify --out-dir <dir> --version <semver> --arch <arm64|x64> [--require-signed] [--require-notarized] [--latest-mac-yml <path>]",
      ].join("\n"),
    );
    return;
  }

  if (subcommand === "generate") {
    const inDir = getFlagValue(args, "--in-dir");
    const version = getFlagValue(args, "--version");
    const outPath = getFlagValue(args, "--out") ?? LEGACY_MAC_CHANNEL_FILENAME;
    const pubDate = getFlagValue(args, "--pub-date");
    const rawRequiredArches = getFlagValue(args, "--require-arches");

    if (!inDir) throw new Error("Missing required --in-dir <directory-with-mac-zips>.");
    if (!version) throw new Error("Missing required --version <semver>.");

    const requiredArches = rawRequiredArches
      ? rawRequiredArches
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map(normalizeMacLegacyArch)
      : undefined;

    const zipPaths = await collectMacZipFilesInDir(path.resolve(inDir));
    const { metadata } = await writeLegacyMacChannelFile({
      version,
      zipPaths,
      outPath: path.resolve(outPath),
      releaseDate: pubDate,
      requiredArches,
    });
    console.log(
      `[legacy-mac-updater] Wrote ${path.resolve(outPath)} (${metadata.files.map((f) => f.url).join(", ")})`,
    );
    return;
  }

  if (subcommand === "verify") {
    const outDir = getFlagValue(args, "--out-dir");
    const version = getFlagValue(args, "--version");
    const arch = getFlagValue(args, "--arch");
    const latestMacYml = getFlagValue(args, "--latest-mac-yml");
    const requireSigned = args.includes("--require-signed");
    const requireNotarized = args.includes("--require-notarized");
    const skipDmg = args.includes("--skip-dmg");

    if (!outDir) throw new Error("Missing required --out-dir <packager-out-dir>.");
    if (!version) throw new Error("Missing required --version <semver>.");
    if (!arch) throw new Error("Missing required --arch <arm64|x64>.");

    const result = await verifyMacReleaseOutputs({
      outDir: path.resolve(outDir),
      version,
      arch: normalizeMacLegacyArch(arch),
      requireSigned,
      requireNotarized,
      requireDmg: !skipDmg,
      verifyLatestMacYmlPath: latestMacYml ? path.resolve(latestMacYml) : undefined,
    });
    console.log(
      `[legacy-mac-updater] Verified ${result.arch} v${result.version}: ${path.basename(result.zipPath)} (${result.zipSize} bytes, sha512=${result.zipSha512.slice(0, 12)}..., exe=${result.appBundle.executableName}, id=${result.appBundle.bundleId})`,
    );
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand}". Expected "generate" or "verify".`);
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
