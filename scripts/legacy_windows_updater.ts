import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hostPlatform } from "../src/platform/host";
import { isSidecarManifest, SIDECAR_MANIFEST_NAME } from "../src/platform/sidecar";
import { normalizeSemverVersion } from "./desktop_rune_release_manifest";
import { pathExists, resolveRustCompileTarget } from "./releaseBuildUtils";

export const LEGACY_WINDOWS_ELECTRON_APP_GUID = "dd76376f-991d-5a9b-8b5f-cc05306dc019";
export const LEGACY_WINDOWS_X64_CHANNEL_FILENAME = "latest.yml";
export const LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME = "latest-arm64.yml";
export const EXPECTED_WINDOWS_PRODUCT_NAME = "Cowork";
export const EXPECTED_WINDOWS_MAIN_EXE = "cowork-desktop.exe";

export const PE_MACHINE_I386 = 0x014c;
export const PE_MACHINE_X64 = 0x8664;
export const PE_MACHINE_ARM64 = 0xaa64;

export type WindowsLegacyArch = "x64" | "arm64";
export type PeMachineArch = "x64" | "arm64" | "x86" | "unknown";

export interface LegacyWindowsInstallerFileEntry {
  url: string;
  sha512: string;
  size: number;
}

export interface LegacyWindowsChannelMetadata {
  version: string;
  files: LegacyWindowsInstallerFileEntry[];
  path: string;
  sha512: string;
  releaseDate: string;
}

export interface PeInspectionResult {
  machine: number;
  arch: PeMachineArch;
}

export interface WindowsAuthenticodeResult {
  filePath: string;
  status: number;
  statusMessage?: string;
  subject?: string;
}

export interface WindowsProducerVerificationResult {
  arch: WindowsLegacyArch;
  version: string;
  installerPath: string;
  installerSha512: string;
  installerSize: number;
  installerPe: PeInspectionResult;
  channelYmlPath?: string;
  mainBinaryPe?: PeInspectionResult;
  sidecarPe?: PeInspectionResult;
  verifiedSignatures: WindowsAuthenticodeResult[];
}

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_ASSET_BASENAME_RE = /^[A-Za-z0-9._-]+$/;

export function normalizeWindowsLegacyArch(raw: string): WindowsLegacyArch {
  switch (raw.trim().toLowerCase()) {
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x64":
    case "x86_64":
    case "amd64":
      return "x64";
    default:
      throw new Error(`Unsupported Windows architecture "${raw}". Expected x64 or arm64.`);
  }
}

export function resolveLegacyWindowsChannelFilename(
  arch: string,
): typeof LEGACY_WINDOWS_X64_CHANNEL_FILENAME | typeof LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME {
  return normalizeWindowsLegacyArch(arch) === "arm64"
    ? LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME
    : LEGACY_WINDOWS_X64_CHANNEL_FILENAME;
}

export function resolveLegacyWindowsInstallerName(arch: string, version: string): string {
  const normVersion = normalizeSemverVersion(version);
  const normArch = normalizeWindowsLegacyArch(arch);
  return `${EXPECTED_WINDOWS_PRODUCT_NAME}_${normVersion}_${normArch}-setup.exe`;
}

export function classifyLegacyWindowsInstallerArch(fileName: string): WindowsLegacyArch {
  const trimmed = fileName.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    !SAFE_ASSET_BASENAME_RE.test(trimmed)
  ) {
    throw new Error(
      `Invalid Windows installer basename "${fileName}". Expected a safe GitHub release filename without spaces or path separators.`,
    );
  }
  const lower = trimmed.toLowerCase();
  if (!lower.endsWith(".exe")) {
    throw new Error(
      `Expected an .exe filename for Windows legacy updater channel, got "${fileName}".`,
    );
  }
  if (lower.includes("aarch64")) {
    throw new Error(
      `Windows legacy installer "${fileName}" uses "aarch64" instead of "arm64"; electron-updater Provider.findFile matches client arch ("arm64").`,
    );
  }
  const hasArm64 = /(?:^|[_-])arm64(?:[_.-]|$)/.test(lower);
  const hasX64 = /(?:^|[_-])x64(?:[_.-]|$)/.test(lower);
  if (hasArm64 && hasX64) {
    throw new Error(`Ambiguous Windows architecture markers in installer filename "${fileName}".`);
  }
  if (hasArm64) {
    return "arm64";
  }
  if (hasX64) {
    return "x64";
  }
  throw new Error(
    `Unable to classify Windows architecture from installer filename "${fileName}". Expected "x64" or "arm64" marker.`,
  );
}

export async function computeWindowsFileSha512AndSize(
  filePath: string,
): Promise<{ sha512: string; size: number }> {
  const bytes = await fs.readFile(filePath);
  if (bytes.length === 0) {
    throw new Error(`Release artifact is empty: ${filePath}`);
  }
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  return { sha512, size: bytes.length };
}

function isValidSha512Base64(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 64 && decoded.toString("base64") === value;
}

export function validateLegacyWindowsChannelMetadata(
  metadata: LegacyWindowsChannelMetadata,
  expectedArch: WindowsLegacyArch,
): void {
  const channelName = resolveLegacyWindowsChannelFilename(expectedArch);
  const version = normalizeSemverVersion(metadata.version);
  if (metadata.version !== version) {
    throw new Error(
      `${channelName} version "${metadata.version}" must be normalized semver ("${version}").`,
    );
  }
  if (typeof metadata.releaseDate !== "string" || !RFC3339_RE.test(metadata.releaseDate)) {
    throw new Error(`Invalid RFC 3339 releaseDate in ${channelName}: "${metadata.releaseDate}".`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error(`${channelName} must list exactly one .exe file entry for ${expectedArch}.`);
  }

  const entry = metadata.files[0];
  if (!entry) {
    throw new Error(`${channelName} is missing its installer file entry.`);
  }
  const classifiedArch = classifyLegacyWindowsInstallerArch(entry.url);
  if (classifiedArch !== expectedArch) {
    throw new Error(
      `${channelName} references ${classifiedArch} installer "${entry.url}", expected ${expectedArch}.`,
    );
  }
  if (!entry.url.includes(version)) {
    throw new Error(
      `${channelName} installer "${entry.url}" does not match expected release version "${version}".`,
    );
  }
  if (!isValidSha512Base64(entry.sha512)) {
    throw new Error(`Invalid base64 sha512 digest for "${entry.url}" in ${channelName}.`);
  }
  if (!Number.isInteger(entry.size) || entry.size <= 0) {
    throw new Error(`Invalid byte size (${String(entry.size)}) for "${entry.url}".`);
  }
  if (metadata.path !== entry.url) {
    throw new Error(
      `${channelName} top-level path "${metadata.path}" must match files[0].url "${entry.url}".`,
    );
  }
  if (metadata.sha512 !== entry.sha512) {
    throw new Error(`${channelName} top-level sha512 must match files[0].sha512.`);
  }
}

export async function buildLegacyWindowsChannelMetadata(params: {
  version: string;
  arch: string;
  installerPath: string;
  releaseDate?: string;
}): Promise<LegacyWindowsChannelMetadata> {
  const version = normalizeSemverVersion(params.version);
  const arch = normalizeWindowsLegacyArch(params.arch);
  const releaseDate = params.releaseDate?.trim() || new Date().toISOString();
  const fileName = path.basename(params.installerPath);
  const classifiedArch = classifyLegacyWindowsInstallerArch(fileName);
  if (classifiedArch !== arch) {
    throw new Error(
      `Windows installer "${fileName}" classifies as "${classifiedArch}", expected "${arch}".`,
    );
  }
  const { sha512, size } = await computeWindowsFileSha512AndSize(params.installerPath);
  const metadata: LegacyWindowsChannelMetadata = {
    version,
    files: [{ url: fileName, sha512, size }],
    path: fileName,
    sha512,
    releaseDate,
  };
  validateLegacyWindowsChannelMetadata(metadata, arch);
  return metadata;
}

export function serializeLegacyWindowsChannelYaml(metadata: LegacyWindowsChannelMetadata): string {
  const lines: string[] = [`version: ${metadata.version}`, "files:"];
  for (const entry of metadata.files) {
    lines.push(`  - url: ${entry.url}`);
    lines.push(`    sha512: ${entry.sha512}`);
    lines.push(`    size: ${entry.size}`);
  }
  lines.push(`path: ${metadata.path}`);
  lines.push(`sha512: ${metadata.sha512}`);
  lines.push(`releaseDate: '${metadata.releaseDate}'`);
  return `${lines.join("\n")}\n`;
}

export function parseLegacyWindowsChannelYaml(
  rawYaml: string,
  expectedArch: WindowsLegacyArch,
): LegacyWindowsChannelMetadata {
  const channelName = resolveLegacyWindowsChannelFilename(expectedArch);
  const lines = rawYaml.split(/\r?\n/);
  let version = "";
  let topPath = "";
  let topSha512 = "";
  let releaseDate = "";
  const files: LegacyWindowsInstallerFileEntry[] = [];
  let inFiles = false;
  let current: Partial<LegacyWindowsInstallerFileEntry> | null = null;

  const stripQuotes = (raw: string): string => {
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };

  const flushCurrent = () => {
    if (!current) return;
    if (
      typeof current.url !== "string" ||
      typeof current.sha512 !== "string" ||
      typeof current.size !== "number"
    ) {
      throw new Error(`Incomplete file entry in ${channelName}: ${JSON.stringify(current)}`);
    }
    files.push({ url: current.url, sha512: current.sha512, size: current.size });
    current = null;
  };

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (inFiles) {
      const itemMatch = /^\s+-\s+url:\s*(.+)$/.exec(line);
      if (itemMatch?.[1]) {
        flushCurrent();
        current = { url: stripQuotes(itemMatch[1]) };
        continue;
      }
      const fieldMatch = /^\s+(sha512|size):\s*(.+)$/.exec(line);
      if (fieldMatch?.[1] && fieldMatch[2] && current) {
        if (fieldMatch[1] === "sha512") {
          current.sha512 = stripQuotes(fieldMatch[2]);
        } else {
          const parsedSize = Number(stripQuotes(fieldMatch[2]));
          if (!Number.isInteger(parsedSize)) {
            throw new Error(`Invalid integer size in ${channelName}: "${fieldMatch[2]}"`);
          }
          current.size = parsedSize;
        }
        continue;
      }
      flushCurrent();
      inFiles = false;
    }

    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    const kv = /^(version|path|sha512|releaseDate):\s*(.+)$/.exec(line);
    if (kv?.[1] && kv[2]) {
      const val = stripQuotes(kv[2]);
      if (kv[1] === "version") version = val;
      else if (kv[1] === "path") topPath = val;
      else if (kv[1] === "sha512") topSha512 = val;
      else if (kv[1] === "releaseDate") releaseDate = val;
    }
  }
  flushCurrent();

  const metadata: LegacyWindowsChannelMetadata = {
    version,
    files,
    path: topPath,
    sha512: topSha512,
    releaseDate,
  };
  validateLegacyWindowsChannelMetadata(metadata, expectedArch);
  return metadata;
}

/**
 * Mirrors the exact channel + asset selection performed by historical
 * `electron-updater@6.8.9` (`NsisUpdater` + `GitHubProvider` + `applyUpdaterPlatformDefaults`)
 * on Windows x64 (`latest.yml`) and Windows arm64 (`latest-arm64.yml`).
 */
export function selectLegacyWindowsInstallerForClient(
  channels: Partial<Record<string, LegacyWindowsChannelMetadata>>,
  options: {
    arch: WindowsLegacyArch;
    tag: string;
    owner?: string;
    repo?: string;
  },
): {
  channelFile: string;
  fileName: string;
  url: string;
  entry: LegacyWindowsInstallerFileEntry;
  version: string;
} | null {
  const channelFile = resolveLegacyWindowsChannelFilename(options.arch);
  const metadata = channels[channelFile];
  if (!metadata) {
    return null;
  }
  validateLegacyWindowsChannelMetadata(metadata, options.arch);

  const owner = options.owner ?? "mweinbach";
  const repo = options.repo ?? "agent-coworker";
  const baseUrl = new URL("https://github.com/");
  const resolved = metadata.files.map((info) => ({
    url: new URL(
      `/${owner}/${repo}/releases/download/${options.tag}/${info.url.replace(/ /g, "-")}`,
      baseUrl,
    ),
    info,
  }));

  // Mirrors Provider.findFile(files, "exe") using the client's target arch
  const exeFiles = resolved.filter((item) => item.url.pathname.toLowerCase().endsWith(".exe"));
  const chosen =
    exeFiles.find((item) =>
      [item.url.pathname, item.info.url].some((candidate) => candidate.includes(options.arch)),
    ) ?? exeFiles[0];

  if (!chosen) {
    return null;
  }

  return {
    channelFile,
    fileName: chosen.info.url,
    url: chosen.url.toString(),
    entry: chosen.info,
    version: metadata.version,
  };
}

export async function writeLegacyWindowsChannelFile(params: {
  version: string;
  arch: string;
  installerPath: string;
  outPath: string;
  releaseDate?: string;
}): Promise<{ metadata: LegacyWindowsChannelMetadata; yaml: string }> {
  const metadata = await buildLegacyWindowsChannelMetadata({
    version: params.version,
    arch: params.arch,
    installerPath: params.installerPath,
    releaseDate: params.releaseDate,
  });
  const yaml = serializeLegacyWindowsChannelYaml(metadata);
  await fs.mkdir(path.dirname(params.outPath), { recursive: true });
  await fs.writeFile(params.outPath, yaml, "utf8");
  return { metadata, yaml };
}

export async function collectWindowsInstallerFilesInDir(inDir: string): Promise<string[]> {
  const entries = await fs.readdir(inDir, { withFileTypes: true });
  const exePaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase().endsWith("-setup.exe")) {
      exePaths.push(path.join(inDir, entry.name));
    }
  }
  return exePaths.sort();
}

export async function writeLegacyWindowsChannelFilesForDir(params: {
  inDir: string;
  outDir: string;
  version: string;
  releaseDate?: string;
  requiredArches?: readonly WindowsLegacyArch[];
}): Promise<
  Array<{
    arch: WindowsLegacyArch;
    channelFile: string;
    outPath: string;
    metadata: LegacyWindowsChannelMetadata;
  }>
> {
  const version = normalizeSemverVersion(params.version);
  const installerPaths = await collectWindowsInstallerFilesInDir(params.inDir);
  if (installerPaths.length === 0) {
    throw new Error(`No Windows *-setup.exe installers found in ${params.inDir}.`);
  }

  const byArch = new Map<WindowsLegacyArch, string>();
  for (const installerPath of installerPaths) {
    const fileName = path.basename(installerPath);
    const arch = classifyLegacyWindowsInstallerArch(fileName);
    if (byArch.has(arch)) {
      throw new Error(
        `Duplicate Windows "${arch}" installer found in ${params.inDir}: "${path.basename(byArch.get(arch) ?? "")}" and "${fileName}".`,
      );
    }
    byArch.set(arch, installerPath);
  }

  for (const requiredArch of params.requiredArches ?? []) {
    if (!byArch.has(requiredArch)) {
      throw new Error(
        `Missing required Windows "${requiredArch}" installer in ${params.inDir} (found: ${[...byArch.keys()].join(", ") || "none"}).`,
      );
    }
  }

  const results: Array<{
    arch: WindowsLegacyArch;
    channelFile: string;
    outPath: string;
    metadata: LegacyWindowsChannelMetadata;
  }> = [];

  for (const arch of ["x64", "arm64"] as const) {
    const installerPath = byArch.get(arch);
    if (!installerPath) continue;
    const channelFile = resolveLegacyWindowsChannelFilename(arch);
    const outPath = path.join(params.outDir, channelFile);
    const { metadata } = await writeLegacyWindowsChannelFile({
      version,
      arch,
      installerPath,
      outPath,
      releaseDate: params.releaseDate,
    });
    results.push({ arch, channelFile, outPath, metadata });
  }

  return results;
}

export async function inspectPeMachine(filePath: string): Promise<PeInspectionResult> {
  const buf = await fs.readFile(filePath);
  if (buf.length < 0x40) {
    throw new Error(`File too small to be a valid PE executable: ${filePath}`);
  }
  const dosMagic = buf.readUInt16LE(0);
  if (dosMagic !== 0x5a4d) {
    throw new Error(
      `Invalid DOS header magic 0x${dosMagic.toString(16)} in ${filePath} (expected 0x5a4d).`,
    );
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 6 > buf.length) {
    throw new Error(`Invalid PE header offset 0x${peOffset.toString(16)} in ${filePath}.`);
  }
  const peSignature = buf.readUInt32LE(peOffset);
  if (peSignature !== 0x00004550) {
    throw new Error(
      `Invalid PE signature 0x${peSignature.toString(16)} in ${filePath} (expected 0x00004550).`,
    );
  }
  const machine = buf.readUInt16LE(peOffset + 4);
  let arch: PeMachineArch = "unknown";
  if (machine === PE_MACHINE_X64) arch = "x64";
  else if (machine === PE_MACHINE_ARM64) arch = "arm64";
  else if (machine === PE_MACHINE_I386) arch = "x86";
  return { machine, arch };
}

function expectedNativePeMachine(arch: WindowsLegacyArch): number {
  return arch === "arm64" ? PE_MACHINE_ARM64 : PE_MACHINE_X64;
}

async function execCapture(
  cmd: string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export async function verifyWindowsAuthenticodeSignature(
  filePath: string,
  expectedPublisher?: string,
): Promise<WindowsAuthenticodeResult> {
  if (hostPlatform() !== "win32") {
    throw new Error(
      `Authenticode verification for ${filePath} requires a Windows host (current host: ${hostPlatform()}).`,
    );
  }
  const escaped = filePath.replaceAll("'", "''");
  const script = `Get-AuthenticodeSignature -LiteralPath '${escaped}' | Select-Object Status, StatusMessage, @{Name='Subject';Expression={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress`;
  const result = await execCapture(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Get-AuthenticodeSignature failed for ${filePath}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim()) as {
    Status?: number;
    StatusMessage?: string;
    Subject?: string | null;
  };
  if (parsed.Status !== 0) {
    throw new Error(
      `Authenticode signature status for ${filePath} is ${String(parsed.Status)} (${parsed.StatusMessage ?? "not valid"}); expected Valid (0).`,
    );
  }
  const subject = typeof parsed.Subject === "string" ? parsed.Subject : undefined;
  if (expectedPublisher?.trim()) {
    if (!subject?.includes(expectedPublisher.trim())) {
      throw new Error(
        `Authenticode signer subject "${subject ?? ""}" for ${filePath} does not match expected publisher "${expectedPublisher.trim()}".`,
      );
    }
  }
  return {
    filePath,
    status: parsed.Status,
    statusMessage: parsed.StatusMessage,
    subject,
  };
}

export async function verifyWindowsReleaseOutputs(params: {
  outDir: string;
  version: string;
  arch: WindowsLegacyArch;
  stagedDir?: string;
  binariesDir?: string;
  verifyChannelYmlPath?: string;
  requireSigned?: boolean;
  expectedPublisher?: string;
}): Promise<WindowsProducerVerificationResult> {
  const version = normalizeSemverVersion(params.version);
  const arch = normalizeWindowsLegacyArch(params.arch);
  const installerName = resolveLegacyWindowsInstallerName(arch, version);
  const installerPath = path.join(params.outDir, installerName);

  if (!(await pathExists(installerPath))) {
    throw new Error(`Missing Windows NSIS installer: ${installerPath}`);
  }

  const installerPe = await inspectPeMachine(installerPath);
  if (installerPe.arch === "unknown") {
    throw new Error(
      `Windows NSIS installer ${installerPath} has unsupported PE machine 0x${installerPe.machine.toString(16)}.`,
    );
  }

  const { sha512: installerSha512, size: installerSize } =
    await computeWindowsFileSha512AndSize(installerPath);

  if (params.verifyChannelYmlPath) {
    const rawYml = await fs.readFile(params.verifyChannelYmlPath, "utf8");
    const metadata = parseLegacyWindowsChannelYaml(rawYml, arch);
    if (metadata.version !== version) {
      throw new Error(
        `${params.verifyChannelYmlPath} version "${metadata.version}" does not match expected "${version}".`,
      );
    }
    const entry = metadata.files[0];
    if (!entry || entry.url !== installerName) {
      throw new Error(
        `${params.verifyChannelYmlPath} references "${entry?.url ?? ""}", expected "${installerName}".`,
      );
    }
    if (entry.size !== installerSize) {
      throw new Error(
        `${params.verifyChannelYmlPath} size mismatch for ${installerName}: metadata=${entry.size}, actual=${installerSize}.`,
      );
    }
    if (entry.sha512 !== installerSha512) {
      throw new Error(
        `${params.verifyChannelYmlPath} sha512 mismatch for ${installerName}: metadata=${entry.sha512}, actual=${installerSha512}.`,
      );
    }
  }

  const expectedMachine = expectedNativePeMachine(arch);
  const filesToVerifyAuthenticode: string[] = [installerPath];
  let mainBinaryPe: PeInspectionResult | undefined;

  if (params.binariesDir) {
    const mainExePath = path.join(params.binariesDir, EXPECTED_WINDOWS_MAIN_EXE);
    if (!(await pathExists(mainExePath))) {
      throw new Error(`Missing built Windows main binary: ${mainExePath}`);
    }
    mainBinaryPe = await inspectPeMachine(mainExePath);
    if (mainBinaryPe.machine !== expectedMachine) {
      throw new Error(
        `PE machine mismatch for ${mainExePath}: got 0x${mainBinaryPe.machine.toString(16)} (${mainBinaryPe.arch}), expected 0x${expectedMachine.toString(16)} (${arch}).`,
      );
    }
    filesToVerifyAuthenticode.push(mainExePath);
  }

  let sidecarPe: PeInspectionResult | undefined;

  if (params.stagedDir) {
    const rustTarget = resolveRustCompileTarget("win32", arch);
    const expectedSidecarName = `cowork-server-${rustTarget}.exe`;
    const binariesRoot = path.join(params.stagedDir, "binaries");
    const sidecarPath = path.join(binariesRoot, expectedSidecarName);
    const sidecarManifestPath = path.join(binariesRoot, SIDECAR_MANIFEST_NAME);

    if (!(await pathExists(sidecarManifestPath))) {
      throw new Error(`Missing staged Windows sidecar manifest: ${sidecarManifestPath}`);
    }
    const parsedManifest: unknown = JSON.parse(await fs.readFile(sidecarManifestPath, "utf8"));
    if (
      !isSidecarManifest(parsedManifest) ||
      parsedManifest.platform !== "win32" ||
      parsedManifest.arch !== arch ||
      parsedManifest.targetTriple !== rustTarget ||
      parsedManifest.launch.path !== expectedSidecarName
    ) {
      throw new Error(
        `Staged Windows sidecar manifest ${sidecarManifestPath} does not match win32/${arch} (${expectedSidecarName}).`,
      );
    }

    if (!(await pathExists(sidecarPath))) {
      throw new Error(`Missing staged Windows sidecar executable: ${sidecarPath}`);
    }
    sidecarPe = await inspectPeMachine(sidecarPath);
    if (sidecarPe.machine !== expectedMachine) {
      throw new Error(
        `PE machine mismatch for ${sidecarPath}: got 0x${sidecarPe.machine.toString(16)} (${sidecarPe.arch}), expected 0x${expectedMachine.toString(16)} (${arch}).`,
      );
    }
    filesToVerifyAuthenticode.push(sidecarPath);
  }

  const verifiedSignatures: WindowsAuthenticodeResult[] = [];
  if (params.requireSigned) {
    for (const exePath of filesToVerifyAuthenticode) {
      const sig = await verifyWindowsAuthenticodeSignature(exePath, params.expectedPublisher);
      verifiedSignatures.push(sig);
    }
  }

  return {
    arch,
    version,
    installerPath,
    installerSha512,
    installerSize,
    installerPe,
    channelYmlPath: params.verifyChannelYmlPath,
    mainBinaryPe,
    sidecarPe,
    verifiedSignatures,
  };
}

export function validateMigrationNsisTemplate(templateText: string): void {
  const requiredTokens = [
    // Core cargo-packager Handlebars placeholders
    "{{main_binary_name}}",
    "{{main_binary_path}}",
    "{{uninstaller_sign_cmd}}",
    "{{version}}",
    "{{arch}}",
    "{{#each resources}}",
    "{{#each resources_dirs}}",
    "{{#each binaries}}",
    // Legacy Electron identity & ownership
    LEGACY_WINDOWS_ELECTRON_APP_GUID,
    "Cowork.exe",
    "Uninstall Cowork.exe",
    // Legacy electron-updater flags + stock Rune flags
    '"--updated"',
    '"--force-run"',
    '"--keep-shortcuts"',
    '"--no-desktop-shortcut"',
    '"/allusers"',
    '"/currentuser"',
    '"/P"',
    '"/R"',
    '"/NS"',
    // 64-bit registry view, synchronous privilege handoff, non-elevated single launch
    "SetRegView 64",
    "IsUserAnAdmin",
    "ShellExecuteExW",
    "WaitForSingleObject",
    "GetExitCodeProcess",
    "CloseHandle",
    "/COWORK_ELEVATED",
    "/COWORK_DEFER_LAUNCH",
    "COWORK_EXIT_LAUNCH_REQUESTED",
    "LaunchCoworkNonElevated",
    "MUI_FINISHPAGE_RUN_FUNCTION OnFinishPageRun",
    "GetShellWindow",
    // Full ancestor validation, user-profile exclusion, non-recursive owned cleanup, retry/shell
    "GetFileAttributesW",
    "GetFullPathNameW",
    "GetLongPathNameW",
    "0x400",
    "IsForbiddenSubtree",
    "$UserAppDataDir",
    "$PROFILE\\AppData\\Roaming",
    "\\AppData\\Roaming\\",
    "\\.cowork\\",
    "DeleteOwnedNonReparseFile",
    "IsSafeExistingNonReparseDir",
    "RemoveEmptyKnownSubdirChain",
    "${UnStrStr}",
    "MigrationInProgress",
    "MigratedFrom",
    "ApplicationID::Set",
    "SHChangeNotify",
  ];
  for (const token of requiredTokens) {
    if (!templateText.includes(token)) {
      throw new Error(`Migration NSIS template is missing required contract token: ${token}`);
    }
  }

  // Must NOT depend on electron-builder-only NSIS plugins absent from cargo-packager's NSIS toolset
  const forbiddenTokens = ["StdUtils::", "WinShell::", "UAC_RunElevated", "UAC_IsAdmin"];
  for (const forbidden of forbiddenTokens) {
    if (templateText.includes(forbidden)) {
      throw new Error(
        `Migration NSIS template must not use unavailable plugin/macro "${forbidden}".`,
      );
    }
  }

  // Strip full-line NSIS comments (`; ...`) for executable-line safety checks
  const activeLines = templateText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(";"));
  const activeScript = activeLines.join("\n");

  // Must NEVER delete user data directories
  const forbiddenUserDataDeletes = [
    'RMDir /r "$APPDATA',
    'RmDir /r "$APPDATA',
    'RMDir /r "$PROFILE\\.cowork',
    'RmDir /r "$PROFILE\\.cowork',
    'RMDir /r "$UserAppDataDir',
    'RmDir /r "$UserAppDataDir',
  ];
  for (const forbidden of forbiddenUserDataDeletes) {
    if (activeScript.includes(forbidden)) {
      throw new Error(
        `Migration NSIS template must never delete user data directories (${forbidden}).`,
      );
    }
  }

  // Must NEVER perform recursive directory deletion (`RMDir /r`) anywhere in installer or uninstaller
  if (/\bRMDir\s+\/r\b/i.test(activeScript)) {
    throw new Error(
      "Migration NSIS template must not use recursive `RMDir /r`; delete only known owned files and empty directories.",
    );
  }

  // Must NOT use fire-and-forget `ShellExecuteW(..., "runas", ...)` without waiting
  if (/ShellExecuteW\s*\([^)]*"runas"/i.test(activeScript)) {
    throw new Error(
      'Migration NSIS template must use synchronous ShellExecuteExW + WaitForSingleObject + GetExitCodeProcess instead of fire-and-forget ShellExecuteW("runas").',
    );
  }

  // Must NOT bind `MUI_FINISHPAGE_RUN` directly to an executable path (which would launch elevated)
  if (/^!define\s+MUI_FINISHPAGE_RUN\s+"/m.test(activeScript)) {
    throw new Error(
      "Migration NSIS template must use `MUI_FINISHPAGE_RUN_FUNCTION` instead of direct `MUI_FINISHPAGE_RUN` executable launch.",
    );
  }

  // Uninstaller elevation of `$INSTDIR\uninstall.exe` must omit `_?=` so NSIS restores standard
  // `%TEMP%` copy self-removal; `_?=$INSTDIR` is only permitted on the `$EXEPATH` fallback.
  const unOnInitMatch = activeScript.match(/Function\s+un\.onInit\b([\s\S]*?)FunctionEnd/);
  if (!unOnInitMatch) {
    throw new Error("Migration NSIS template is missing `Function un.onInit`.");
  }
  const unOnInitBody = unOnInitMatch[1];
  const installedUninstBranch = unOnInitBody.match(
    /\$\{If\}\s+\$\{FileExists\}\s+"\$INSTDIR\\uninstall\.exe"([\s\S]*?)\$\{Else\}/,
  );
  if (!installedUninstBranch) {
    throw new Error(
      'Migration NSIS template `un.onInit` must branch on `${FileExists} "$INSTDIR\\uninstall.exe"` when elevating.',
    );
  }
  if (installedUninstBranch[1].includes("_?=")) {
    throw new Error(
      'Migration NSIS template `un.onInit` must omit `_?=` when elevating "$INSTDIR\\uninstall.exe" so NSIS temp-copy self-removal works.',
    );
  }

  // Verify NSIS and Handlebars block balance across the template
  const countMatches = (regex: RegExp) => activeLines.filter((line) => regex.test(line)).length;
  const blockPairs: Array<[string, RegExp, RegExp]> = [
    ["Function/FunctionEnd", /^Function\s+/, /^FunctionEnd$/],
    ["Section/SectionEnd", /^Section(?:\s+|$)/, /^SectionEnd$/],
    ["!macro/!macroend", /^!macro\s+/, /^!macroend$/],
    ["!if/!endif", /^!if(?:n?def)?\s+/, /^!endif$/],
    ["${If}/${EndIf}", /^\$\{If(?:Not)?\}\s+/, /^\$\{EndIf\}$/],
    ["${Do}/${Loop}", /^\$\{Do(?:While)?\}(?:\s+|$)/, /^\$\{Loop\}$/],
  ];
  for (const [label, openRe, closeRe] of blockPairs) {
    const opens = countMatches(openRe);
    const closes = countMatches(closeRe);
    if (opens !== closes) {
      throw new Error(
        `Migration NSIS template has unbalanced ${label} blocks (open=${opens}, close=${closes}).`,
      );
    }
  }
  const hbEachOpen = (templateText.match(/\{\{#each\b/g) ?? []).length;
  const hbEachClose = (templateText.match(/\{\{\/each\}\}/g) ?? []).length;
  if (hbEachOpen !== hbEachClose) {
    throw new Error(
      `Migration NSIS template has unbalanced Handlebars {{#each}} blocks (open=${hbEachOpen}, close=${hbEachClose}).`,
    );
  }
  const hbIfOpen = (templateText.match(/\{\{#if\b/g) ?? []).length;
  const hbIfClose = (templateText.match(/\{\{\/if\}\}/g) ?? []).length;
  if (hbIfOpen !== hbIfClose) {
    throw new Error(
      `Migration NSIS template has unbalanced Handlebars {{#if}} blocks (open=${hbIfOpen}, close=${hbIfClose}).`,
    );
  }
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
        "  bun scripts/legacy_windows_updater.ts generate --in-dir <dir> --version <semver> [--out-dir <dir>] [--pub-date <iso8601>] [--require-arches x64,arm64]",
        "  bun scripts/legacy_windows_updater.ts verify --out-dir <dir> --version <semver> --arch <x64|arm64> [--staged-dir <dir>] [--binaries-dir <dir>] [--channel-yml <path>] [--require-signed] [--publisher <subject>]",
      ].join("\n"),
    );
    return;
  }

  if (subcommand === "generate") {
    const inDir = getFlagValue(args, "--in-dir");
    const version = getFlagValue(args, "--version");
    const outDir = getFlagValue(args, "--out-dir") ?? inDir;
    const pubDate = getFlagValue(args, "--pub-date");
    const rawRequiredArches = getFlagValue(args, "--require-arches");

    if (!inDir) throw new Error("Missing required --in-dir <directory-with-windows-installers>.");
    if (!version) throw new Error("Missing required --version <semver>.");

    const requiredArches = rawRequiredArches
      ? rawRequiredArches
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map(normalizeWindowsLegacyArch)
      : undefined;

    const written = await writeLegacyWindowsChannelFilesForDir({
      inDir: path.resolve(inDir),
      outDir: path.resolve(outDir ?? inDir),
      version,
      releaseDate: pubDate,
      requiredArches,
    });
    for (const item of written) {
      console.log(
        `[legacy-windows-updater] Wrote ${item.outPath} (${item.arch} -> ${item.metadata.path})`,
      );
    }
    return;
  }

  if (subcommand === "verify") {
    const outDir = getFlagValue(args, "--out-dir");
    const version = getFlagValue(args, "--version");
    const arch = getFlagValue(args, "--arch");
    const stagedDir = getFlagValue(args, "--staged-dir");
    const binariesDir = getFlagValue(args, "--binaries-dir");
    const channelYml = getFlagValue(args, "--channel-yml");
    const requireSigned = args.includes("--require-signed");
    const expectedPublisher = getFlagValue(args, "--publisher");

    if (!outDir) throw new Error("Missing required --out-dir <packager-out-dir>.");
    if (!version) throw new Error("Missing required --version <semver>.");
    if (!arch) throw new Error("Missing required --arch <x64|arm64>.");

    const result = await verifyWindowsReleaseOutputs({
      outDir: path.resolve(outDir),
      version,
      arch: normalizeWindowsLegacyArch(arch),
      stagedDir: stagedDir ? path.resolve(stagedDir) : undefined,
      binariesDir: binariesDir ? path.resolve(binariesDir) : undefined,
      verifyChannelYmlPath: channelYml ? path.resolve(channelYml) : undefined,
      requireSigned,
      expectedPublisher,
    });
    console.log(
      `[legacy-windows-updater] Verified ${result.arch} v${result.version}: ${path.basename(result.installerPath)} (${result.installerSize} bytes, sha512=${result.installerSha512.slice(0, 12)}..., signed=${result.verifiedSignatures.length})`,
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
