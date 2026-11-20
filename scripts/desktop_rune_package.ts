import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "../src/platform/exec";
import { hostArch, hostPlatform } from "../src/platform/host";
import { home } from "../src/platform/paths";
import { scratchRoots } from "../src/platform/scratchRoots";
import {
  isSidecarManifest,
  resolveStagedBinariesDir,
  SIDECAR_MANIFEST_NAME,
} from "../src/platform/sidecar";
import {
  WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  WINDOWS_SANDBOX_HASH_MANIFEST_NAME,
  WINDOWS_SANDBOX_HELPER_NAME,
  WINDOWS_SANDBOX_SETUP_NAME,
} from "../src/platform/windowsSandboxHelper";
import {
  normalizeSemverVersion,
  type UpdaterFragment,
  type UpdaterPayloadFormat,
  type UpdaterPlatformKey,
} from "./desktop_rune_release_manifest";
import {
  EXPECTED_MAC_EXECUTABLE_NAME,
  LEGACY_MAC_CHANNEL_FILENAME,
  resolveLegacyMacZipName,
  resolveMacDmgName,
  resolveMacTarGzName,
  verifyMacReleaseOutputs,
  writeLegacyMacChannelFile,
} from "./legacy_mac_updater";
import {
  resolveLegacyWindowsChannelFilename,
  resolveLegacyWindowsInstallerName,
  validateMigrationNsisTemplate,
  verifyWindowsReleaseOutputs,
  writeLegacyWindowsChannelFile,
} from "./legacy_windows_updater";
import {
  pathExists,
  resolveBuildTarget,
  resolveRustCompileTarget,
  rmrf,
  runCommand,
} from "./releaseBuildUtils";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type PackagerFormat = "app" | "dmg" | "nsis" | "wix" | "deb" | "appimage";

export interface PackageCliOptions {
  platform: NodeJS.Platform;
  arch: string;
  formats: PackagerFormat[];
  version?: string;
  outDir?: string;
  binariesDir?: string;
  skipBuild: boolean;
  skipResources: boolean;
  skipSign: boolean;
  skipNotarize: boolean;
  requireSign: boolean;
  forceCargoTarget: boolean;
}

export interface StagedResourceMapping {
  src: string;
  target: string;
}

export interface PackagerJsonConfig {
  name: string;
  productName: string;
  version: string;
  identifier: string;
  publisher?: string;
  description?: string;
  copyright?: string;
  category?: string;
  outDir: string;
  binariesDir: string;
  targetTriple?: string;
  icons: string[];
  binaries: Array<{ path: string; main: boolean }>;
  resources: StagedResourceMapping[];
  macos?: {
    minimumSystemVersion?: string;
    entitlements?: string;
    signingIdentity?: string;
  };
  dmg?: Record<string, unknown>;
  windows?: {
    digestAlgorithm?: string;
    certificateThumbprint?: string;
    tsp?: boolean;
    timestampUrl?: string;
    allowDowngrades?: boolean;
    signCommand?: string;
  };
  nsis?: Record<string, unknown>;
  linux?: Record<string, unknown>;
  deb?: Record<string, unknown>;
}

export interface ResolvedMacSigningCredentials {
  env: Record<string, string>;
  hasCertificate: boolean;
  hasNotarizeCredentials: boolean;
  signingIdentity?: string;
  tempFilesToCleanup: string[];
}

const VALID_PACKAGER_FORMATS = new Set<PackagerFormat>([
  "app",
  "dmg",
  "nsis",
  "wix",
  "deb",
  "appimage",
]);

const WINDOWS_SANDBOX_FILES = [
  WINDOWS_SANDBOX_HELPER_NAME,
  WINDOWS_SANDBOX_SETUP_NAME,
  WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
] as const;

const WINDOWS_SANDBOX_MANIFEST_NAME = WINDOWS_SANDBOX_HASH_MANIFEST_NAME;

const TELEMETRY_BUILD_ENV_KEYS = [
  "COWORK_SENTRY_DSN",
  "COWORK_SENTRY_ENVIRONMENT",
  "COWORK_POSTHOG_KEY",
  "COWORK_POSTHOG_HOST",
  "COWORK_POSTHOG_ENVIRONMENT",
] as const;

export function normalizePlatformName(raw: string): NodeJS.Platform {
  switch (raw.trim().toLowerCase()) {
    case "darwin":
    case "macos":
    case "mac":
      return "darwin";
    case "win32":
    case "windows":
    case "win":
      return "win32";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported target platform "${raw}". Expected darwin, win32, or linux.`);
  }
}

export function normalizeArchName(raw: string): "arm64" | "x64" {
  switch (raw.trim().toLowerCase()) {
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x64":
    case "x86_64":
    case "amd64":
      return "x64";
    default:
      throw new Error(`Unsupported target arch "${raw}". Expected arm64 or x64.`);
  }
}

export function resolvePlatformKey(platform: NodeJS.Platform, arch: string): UpdaterPlatformKey {
  const normArch = normalizeArchName(arch) === "arm64" ? "aarch64" : "x86_64";
  switch (platform) {
    case "darwin":
      return `macos-${normArch}` as UpdaterPlatformKey;
    case "win32":
      return `windows-${normArch}` as UpdaterPlatformKey;
    case "linux":
      return `linux-${normArch}` as UpdaterPlatformKey;
    default:
      throw new Error(`Unsupported OS for Rune desktop packaging: ${platform}`);
  }
}

export function resolveDefaultFormats(platform: NodeJS.Platform): PackagerFormat[] {
  switch (platform) {
    case "darwin":
      return ["app", "dmg"];
    case "win32":
      return ["nsis"];
    case "linux":
      return ["deb", "appimage"];
    default:
      throw new Error(`Unsupported OS for Rune desktop packaging: ${platform}`);
  }
}

export function resolveUpdaterPayloadDescriptor(
  platform: NodeJS.Platform,
  arch: string,
  version: string,
  formats: readonly PackagerFormat[],
): { format: UpdaterPayloadFormat; fileName: string } | null {
  const normVersion = normalizeSemverVersion(version);
  const normArch = normalizeArchName(arch);
  if (platform === "darwin") {
    const macArch = normArch === "arm64" ? "aarch64" : "x64";
    if (!formats.includes("app")) return null;
    return { format: "app", fileName: `Cowork_${normVersion}_${macArch}.app.tar.gz` };
  }
  if (platform === "win32") {
    if (formats.includes("nsis")) {
      const winArch = normArch === "arm64" ? "arm64" : "x64";
      return { format: "nsis", fileName: `Cowork_${normVersion}_${winArch}-setup.exe` };
    }
    if (formats.includes("wix")) {
      const winArch = normArch === "arm64" ? "arm64" : "x64";
      return { format: "wix", fileName: `Cowork_${normVersion}_${winArch}.msi` };
    }
    return null;
  }
  if (platform === "linux" && formats.includes("appimage")) {
    const linuxArch = normArch === "arm64" ? "aarch64" : "x86_64";
    return { format: "appimage", fileName: `Cowork_${normVersion}_${linuxArch}.AppImage` };
  }
  return null;
}

export function resolveMacArchiveNames(arch: string, version: string) {
  const normVersion = normalizeSemverVersion(version);
  const normArch = normalizeArchName(arch);
  return {
    dmgName: resolveMacDmgName(normArch, normVersion),
    zipName: resolveLegacyMacZipName(normArch, normVersion),
    updaterTarGzName: resolveMacTarGzName(normArch, normVersion),
  };
}

function getFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1];
  }
  const prefix = `${flag}=`;
  const matched = argv.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : undefined;
}

function parseTargetShorthand(rawTarget: string): {
  platform: NodeJS.Platform;
  arch: "arm64" | "x64";
} {
  const trimmed = rawTarget.trim().toLowerCase();
  if (trimmed === "aarch64-apple-darwin") return { platform: "darwin", arch: "arm64" };
  if (trimmed === "x86_64-apple-darwin") return { platform: "darwin", arch: "x64" };
  if (trimmed === "x86_64-pc-windows-msvc") return { platform: "win32", arch: "x64" };
  if (trimmed === "aarch64-pc-windows-msvc") return { platform: "win32", arch: "arm64" };
  if (trimmed === "x86_64-unknown-linux-gnu") return { platform: "linux", arch: "x64" };
  if (trimmed === "aarch64-unknown-linux-gnu") return { platform: "linux", arch: "arm64" };

  const parts = trimmed.split("-");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return {
      platform: normalizePlatformName(parts[0]),
      arch: normalizeArchName(parts[1]),
    };
  }
  throw new Error(
    `Unsupported --target "${rawTarget}". Expected <platform>-<arch> (e.g. macos-aarch64) or Rust triple.`,
  );
}

export function parsePackageCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  currentPlatform: NodeJS.Platform = hostPlatform(),
  currentArch: string = hostArch(),
): PackageCliOptions {
  const targetArg = getFlagValue(argv, "--target");
  let platform: NodeJS.Platform;
  let arch: string;

  if (targetArg) {
    const parsed = parseTargetShorthand(targetArg);
    platform = parsed.platform;
    arch = parsed.arch;
  } else {
    const resolved = resolveBuildTarget(argv, env, currentPlatform, currentArch);
    platform = normalizePlatformName(getFlagValue(argv, "--platform") ?? resolved.platform);
    arch = normalizeArchName(getFlagValue(argv, "--arch") ?? resolved.arch);
  }

  const rawFormats = getFlagValue(argv, "--formats");
  const formats = rawFormats
    ? rawFormats
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => {
          if (!VALID_PACKAGER_FORMATS.has(item as PackagerFormat)) {
            throw new Error(`Unsupported package format "${item}".`);
          }
          return item as PackagerFormat;
        })
    : resolveDefaultFormats(platform);

  if (formats.length === 0) {
    throw new Error("At least one package format must be selected.");
  }

  return {
    platform,
    arch,
    formats,
    version: getFlagValue(argv, "--version"),
    outDir: getFlagValue(argv, "--out-dir"),
    binariesDir: getFlagValue(argv, "--binaries-dir"),
    skipBuild: argv.includes("--skip-build"),
    skipResources: argv.includes("--skip-resources"),
    skipSign: argv.includes("--skip-sign") || argv.includes("--unsigned"),
    skipNotarize: argv.includes("--skip-notarize"),
    requireSign: argv.includes("--require-sign"),
    forceCargoTarget: argv.includes("--force-cargo-target") || env.COWORK_FORCE_RUST_TARGET === "1",
  };
}

export async function resolvePackageVersion(
  root: string,
  explicitVersion: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (explicitVersion?.trim()) {
    return normalizeSemverVersion(explicitVersion);
  }
  const envVersion = env.COWORK_APP_VERSION?.trim();
  if (envVersion) {
    return normalizeSemverVersion(envVersion);
  }
  const packagerTomlPath = path.join(
    root,
    "crates",
    "cowork-desktop",
    "packaging",
    "Packager.toml",
  );
  if (await pathExists(packagerTomlPath)) {
    const packagerConfig = Bun.TOML.parse(await fs.readFile(packagerTomlPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof packagerConfig.version === "string" && packagerConfig.version.trim()) {
      return normalizeSemverVersion(packagerConfig.version);
    }
  }
  const rootPkgPath = path.join(root, "package.json");
  if (await pathExists(rootPkgPath)) {
    const rootPkg = JSON.parse(await fs.readFile(rootPkgPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof rootPkg.version === "string" && rootPkg.version.trim()) {
      return normalizeSemverVersion(rootPkg.version);
    }
  }
  throw new Error("Unable to determine Cowork package version.");
}

export function resolveCargoBuildEnv(
  baseEnv: NodeJS.ProcessEnv,
  version: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  out.COWORK_APP_VERSION = normalizeSemverVersion(version);

  const pubkey =
    baseEnv.COWORK_UPDATER_PUBKEY?.trim() ||
    baseEnv.CARGO_PACKAGER_SIGN_PUBLIC_KEY?.trim() ||
    baseEnv.CARGO_PACKAGER_SIGN_PUBKEY?.trim();
  if (pubkey) {
    out.COWORK_UPDATER_PUBKEY = pubkey;
    out.CARGO_PACKAGER_SIGN_PUBLIC_KEY = pubkey;
  }

  for (const key of TELEMETRY_BUILD_ENV_KEYS) {
    const value = baseEnv[key]?.trim();
    if (value) {
      out[key] = value;
    }
  }

  return out;
}

const APPLE_SIGNING_ENV_KEYS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
] as const;

const APPLE_NOTARIZE_ENV_KEYS = [
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_KEY_PATH",
  "APPLE_API_KEY_CONTENT",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_ISSUER",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_KEYCHAIN_PROFILE",
] as const;

export function buildCargoPackagerEnv(params: {
  buildEnv: Record<string, string>;
  macSigningEnv: Record<string, string>;
  skipNotarize: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {
    ...params.buildEnv,
  };
  // Strip raw Apple signing/notarization vars first so unset CI secrets passed as
  // empty strings ("") cannot trigger cargo-packager's `std::env::var_os` checks
  // ahead of the resolved credentials in `macSigningEnv`.
  for (const key of APPLE_SIGNING_ENV_KEYS) {
    delete out[key];
  }
  for (const key of APPLE_NOTARIZE_ENV_KEYS) {
    delete out[key];
  }
  for (const [key, value] of Object.entries(params.macSigningEnv)) {
    if (value !== "" || key === "APPLE_CERTIFICATE_PASSWORD") {
      out[key] = value;
    }
  }
  if (params.skipNotarize) {
    for (const key of APPLE_NOTARIZE_ENV_KEYS) {
      delete out[key];
    }
  }
  return out;
}

export function validateUpdaterSignKeys(params: {
  requireSign: boolean;
  skipSign: boolean;
  minisignPrivateKey?: string;
  updaterPublicKey?: string;
}): void {
  if (!params.requireSign || params.skipSign) return;
  if (!params.minisignPrivateKey?.trim()) {
    throw new Error("--require-sign specified, but CARGO_PACKAGER_SIGN_PRIVATE_KEY is missing.");
  }
  if (!params.updaterPublicKey?.trim()) {
    throw new Error(
      "--require-sign specified, but COWORK_UPDATER_PUBKEY (or CARGO_PACKAGER_SIGN_PUBLIC_KEY) is missing.",
    );
  }
}

export async function prepareMacSigningEnv(
  env: NodeJS.ProcessEnv,
  options: { tempDir?: string; skipNotarize?: boolean; platform?: NodeJS.Platform } = {},
): Promise<ResolvedMacSigningCredentials> {
  const resolved: Record<string, string> = {};
  const tempFilesToCleanup: string[] = [];
  const tempDir = options.tempDir ?? scratchRoots()[0] ?? "/tmp";
  const currentPlatform = options.platform ?? hostPlatform();

  const appleCert = env.APPLE_CERTIFICATE?.trim();
  const cscCert = env.CSC_LINK?.trim();
  const rawCert = appleCert || cscCert;
  const certPassword = appleCert
    ? env.APPLE_CERTIFICATE_PASSWORD || env.CSC_KEY_PASSWORD || ""
    : env.CSC_KEY_PASSWORD || env.APPLE_CERTIFICATE_PASSWORD || "";

  let p12PathForIdentityProbe: string | undefined;
  if (rawCert) {
    let base64Cert = rawCert;
    if (fsSync.existsSync(rawCert)) {
      const bytes = await fs.readFile(rawCert);
      base64Cert = bytes.toString("base64");
      p12PathForIdentityProbe = rawCert;
    } else {
      const normalizedBase64 = rawCert.replace(/\s+/g, "");
      base64Cert = normalizedBase64;
      const p12Path = path.join(tempDir, `cowork-cert-${process.pid}-${Date.now()}.p12`);
      await fs.writeFile(p12Path, Buffer.from(normalizedBase64, "base64"), { mode: 0o600 });
      p12PathForIdentityProbe = p12Path;
      tempFilesToCleanup.push(p12Path);
    }
    resolved.APPLE_CERTIFICATE = base64Cert;
    resolved.APPLE_CERTIFICATE_PASSWORD = certPassword;
  }

  let signingIdentity = env.APPLE_SIGNING_IDENTITY?.trim() || env.CSC_NAME?.trim() || undefined;
  if (!signingIdentity && p12PathForIdentityProbe && currentPlatform === "darwin") {
    signingIdentity = await extractSigningIdentityFromP12(
      p12PathForIdentityProbe,
      certPassword,
      tempDir,
    );
  }
  if (signingIdentity) {
    resolved.APPLE_SIGNING_IDENTITY = signingIdentity;
  }

  let hasNotarizeCredentials = false;
  if (!options.skipNotarize) {
    const apiKeyContent =
      env.APPLE_API_KEY_CONTENT?.trim() ||
      (env.APPLE_API_KEY?.includes("-----BEGIN") ? env.APPLE_API_KEY.trim() : undefined);
    const apiKeyId =
      env.APPLE_API_KEY_ID?.trim() ||
      (!env.APPLE_API_KEY?.includes("-----BEGIN") ? env.APPLE_API_KEY?.trim() : undefined);
    const apiKeyPath = env.APPLE_API_KEY_PATH?.trim();
    const apiIssuer = env.APPLE_API_ISSUER?.trim() || env.APPLE_API_KEY_ISSUER?.trim();

    if (apiKeyId && apiIssuer && (apiKeyPath || apiKeyContent)) {
      let resolvedPath = apiKeyPath;
      if (!resolvedPath && apiKeyContent) {
        const keyFile = path.join(tempDir, `AuthKey_${apiKeyId}_${process.pid}.p8`);
        await fs.writeFile(keyFile, apiKeyContent, { mode: 0o600 });
        tempFilesToCleanup.push(keyFile);
        resolvedPath = keyFile;
      }
      if (resolvedPath) {
        resolved.APPLE_API_KEY = apiKeyId;
        resolved.APPLE_API_KEY_PATH = resolvedPath;
        resolved.APPLE_API_ISSUER = apiIssuer;
        hasNotarizeCredentials = true;
      }
    } else if (
      env.APPLE_ID?.trim() &&
      (env.APPLE_PASSWORD?.trim() || env.APPLE_APP_SPECIFIC_PASSWORD?.trim()) &&
      env.APPLE_TEAM_ID?.trim()
    ) {
      resolved.APPLE_ID = env.APPLE_ID.trim();
      resolved.APPLE_PASSWORD = (
        env.APPLE_PASSWORD?.trim() ||
        env.APPLE_APP_SPECIFIC_PASSWORD?.trim() ||
        ""
      ).trim();
      resolved.APPLE_TEAM_ID = env.APPLE_TEAM_ID.trim();
      hasNotarizeCredentials = true;
    } else if (env.APPLE_KEYCHAIN_PROFILE?.trim()) {
      resolved.APPLE_KEYCHAIN_PROFILE = env.APPLE_KEYCHAIN_PROFILE.trim();
      hasNotarizeCredentials = true;
    }
  }

  return {
    env: resolved,
    hasCertificate: Boolean(resolved.APPLE_CERTIFICATE || signingIdentity),
    hasNotarizeCredentials,
    signingIdentity,
    tempFilesToCleanup,
  };
}

async function execSpawn(
  command: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    captureOutput?: boolean;
    allowFailure?: boolean;
  } = {},
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: options.captureOutput ? "pipe" : "inherit",
    stderr: options.captureOutput ? "pipe" : "inherit",
  });
  const stdout = options.captureOutput ? await new Response(proc.stdout).text() : "";
  const code = await proc.exited;
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${code}): ${command.join(" ")}`);
  }
  return { code, stdout };
}

async function extractSigningIdentityFromP12(
  p12Path: string,
  password: string,
  tempDir?: string,
): Promise<string | undefined> {
  const passEnvKey = "COWORK_P12_PROBE_PASS";
  let pkcs12 = await execSpawn(
    ["openssl", "pkcs12", "-in", p12Path, "-clcerts", "-nokeys", "-passin", `env:${passEnvKey}`],
    {
      env: { ...process.env, [passEnvKey]: password },
      captureOutput: true,
      allowFailure: true,
    },
  );
  if (pkcs12.code !== 0 || !pkcs12.stdout) {
    pkcs12 = await execSpawn(
      [
        "openssl",
        "pkcs12",
        "-legacy",
        "-in",
        p12Path,
        "-clcerts",
        "-nokeys",
        "-passin",
        `env:${passEnvKey}`,
      ],
      {
        env: { ...process.env, [passEnvKey]: password },
        captureOutput: true,
        allowFailure: true,
      },
    );
  }
  if (pkcs12.code !== 0 || !pkcs12.stdout) {
    return undefined;
  }
  const certMatches = Array.from(
    pkcs12.stdout.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g),
  ).map((match) => match[0]);
  if (certMatches.length === 0) {
    return undefined;
  }
  const tmpPem = path.join(
    tempDir ?? scratchRoots()[0] ?? "/tmp",
    `cowork-cert-subject-${process.pid}.pem`,
  );
  try {
    let fallbackCn: string | undefined;
    for (const pem of certMatches) {
      await fs.writeFile(tmpPem, pem, { mode: 0o600 });
      const subjectResult = await execSpawn(
        ["openssl", "x509", "-in", tmpPem, "-noout", "-subject"],
        { captureOutput: true, allowFailure: true },
      );
      if (subjectResult.code !== 0) {
        continue;
      }
      const cnMatch = subjectResult.stdout.match(/(?:^|[,/])\s*CN\s*=\s*([^,/\n]+)/);
      const cn = cnMatch?.[1]?.trim();
      if (!cn) continue;
      if (cn.startsWith("Developer ID Application")) {
        return cn;
      }
      fallbackCn ??= cn;
    }
    return fallbackCn;
  } finally {
    await fs.rm(tmpPem, { force: true });
  }
}

export async function loadPackagerBaseConfig(root: string): Promise<Record<string, unknown>> {
  const tomlPath = path.join(root, "crates", "cowork-desktop", "packaging", "Packager.toml");
  const rawToml = await fs.readFile(tomlPath, "utf8");
  return Bun.TOML.parse(rawToml) as Record<string, unknown>;
}

export function buildPackagerConfig(params: {
  root: string;
  baseConfig: Record<string, unknown>;
  version: string;
  outDir: string;
  binariesDir: string;
  stagedDir: string;
  targetTriple: string;
  includeWindowsSandbox: boolean;
  macosSigningIdentity?: string;
  windowsCertificateThumbprint?: string;
  windowsSignCommand?: string;
}): PackagerJsonConfig {
  const { root, baseConfig, stagedDir } = params;
  const resolveRepoPath = (relOrAbs: string) =>
    path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs);

  const rawIcons = Array.isArray(baseConfig.icons) ? (baseConfig.icons as string[]) : [];
  const icons = rawIcons.map(resolveRepoPath);

  const macosBase = {
    ...((baseConfig.macos as Record<string, unknown> | undefined) ?? {}),
  };
  if (typeof macosBase.entitlements === "string") {
    macosBase.entitlements = resolveRepoPath(macosBase.entitlements);
  }
  if (params.macosSigningIdentity) {
    macosBase.signingIdentity = params.macosSigningIdentity;
  } else {
    delete macosBase.signingIdentity;
  }

  const windowsBase = {
    ...((baseConfig.windows as Record<string, unknown> | undefined) ?? {}),
  };
  if (params.windowsCertificateThumbprint) {
    windowsBase.certificateThumbprint = params.windowsCertificateThumbprint;
  } else {
    delete windowsBase.certificateThumbprint;
  }
  if (params.windowsSignCommand) {
    windowsBase.signCommand = params.windowsSignCommand;
  } else {
    delete windowsBase.signCommand;
  }

  const nsisBase = {
    ...((baseConfig.nsis as Record<string, unknown> | undefined) ?? {}),
  };
  if (typeof nsisBase.installerIcon === "string") {
    nsisBase.installerIcon = resolveRepoPath(nsisBase.installerIcon);
  }
  if (typeof nsisBase.template === "string") {
    nsisBase.template = resolveRepoPath(nsisBase.template);
  }

  const resources: StagedResourceMapping[] = [
    { src: path.join(stagedDir, "dist", "prompts"), target: "dist/prompts" },
    { src: path.join(stagedDir, "dist", "config"), target: "dist/config" },
    { src: path.join(stagedDir, "dist", "skills"), target: "dist/skills" },
    { src: path.join(stagedDir, "dist", "workflows"), target: "dist/workflows" },
    { src: path.join(stagedDir, "binaries"), target: "binaries" },
    { src: path.join(stagedDir, "tray"), target: "tray" },
  ];
  if (params.includeWindowsSandbox) {
    resources.push({
      src: path.join(stagedDir, "windows-sandbox"),
      target: "windows-sandbox",
    });
  }

  const rawBinaries = Array.isArray(baseConfig.binaries)
    ? (baseConfig.binaries as Array<{ path: string; main: boolean }>)
    : [{ path: "cowork-desktop", main: true }];
  const isMacTarget = params.targetTriple.includes("apple-darwin");
  const binaries = isMacTarget
    ? rawBinaries.map((entry) =>
        entry.main ? { ...entry, path: EXPECTED_MAC_EXECUTABLE_NAME } : entry,
      )
    : rawBinaries;

  return {
    name: typeof baseConfig.name === "string" ? baseConfig.name : "cowork-desktop",
    productName: typeof baseConfig.productName === "string" ? baseConfig.productName : "Cowork",
    version: normalizeSemverVersion(params.version),
    identifier:
      typeof baseConfig.identifier === "string" ? baseConfig.identifier : "com.cowork.desktop",
    publisher: typeof baseConfig.publisher === "string" ? baseConfig.publisher : "Cowork",
    description: typeof baseConfig.description === "string" ? baseConfig.description : undefined,
    copyright: typeof baseConfig.copyright === "string" ? baseConfig.copyright : undefined,
    category: typeof baseConfig.category === "string" ? baseConfig.category : undefined,
    outDir: params.outDir,
    binariesDir: params.binariesDir,
    targetTriple: params.targetTriple,
    icons,
    binaries,
    resources,
    macos: macosBase as PackagerJsonConfig["macos"],
    dmg: (baseConfig.dmg as Record<string, unknown> | undefined) ?? undefined,
    windows: windowsBase as PackagerJsonConfig["windows"],
    nsis: nsisBase,
    linux: (baseConfig.linux as Record<string, unknown> | undefined) ?? undefined,
    deb: (baseConfig.deb as Record<string, unknown> | undefined) ?? undefined,
  };
}

async function copyFilteredDir(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".DS_Store" ||
      entry.name.endsWith(".tsbuildinfo") ||
      entry.name.startsWith(".desktop-resources-cache-") ||
      entry.name.endsWith(".map")
    ) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyFilteredDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
      const stat = await fs.stat(srcPath);
      await fs.chmod(destPath, stat.mode & 0o777);
    }
  }
}

export async function stageRuntimeResources(params: {
  root: string;
  platform: NodeJS.Platform;
  rustTarget: string;
  stagedDir: string;
}): Promise<{ hasWindowsSandbox: boolean }> {
  const { root, platform, rustTarget, stagedDir } = params;
  await rmrf(stagedDir);
  await fs.mkdir(stagedDir, { recursive: true });

  const distSubdirs = ["prompts", "config", "skills", "workflows"] as const;
  for (const subdir of distSubdirs) {
    const src = path.join(root, "dist", subdir);
    if (!(await pathExists(src))) {
      throw new Error(`Missing built resource directory: ${src}`);
    }
    await copyFilteredDir(src, path.join(stagedDir, "dist", subdir));
  }

  const stagedBinariesSrcDir = resolveStagedBinariesDir(root);
  const stagedBinariesDir = path.join(stagedDir, "binaries");
  await fs.mkdir(stagedBinariesDir, { recursive: true });

  const sidecarName =
    platform === "win32" ? `cowork-server-${rustTarget}.exe` : `cowork-server-${rustTarget}`;
  const sidecarSrc = path.join(stagedBinariesSrcDir, sidecarName);
  const manifestSrc = path.join(stagedBinariesSrcDir, SIDECAR_MANIFEST_NAME);
  if (!(await pathExists(sidecarSrc)) || !(await pathExists(manifestSrc))) {
    throw new Error(
      `Missing staged cowork-server sidecar artifacts in ${stagedBinariesSrcDir} (expected ${sidecarName} and ${SIDECAR_MANIFEST_NAME}).`,
    );
  }
  const parsedManifest: unknown = JSON.parse(await fs.readFile(manifestSrc, "utf8"));
  if (
    !isSidecarManifest(parsedManifest) ||
    parsedManifest.platform !== platform ||
    parsedManifest.targetTriple !== rustTarget ||
    parsedManifest.launch.path !== sidecarName
  ) {
    throw new Error(
      `Staged sidecar manifest in ${manifestSrc} does not match target ${platform}/${rustTarget} (${sidecarName}).`,
    );
  }
  const sidecarDest = path.join(stagedBinariesDir, sidecarName);
  await fs.copyFile(sidecarSrc, sidecarDest);
  await fs.copyFile(manifestSrc, path.join(stagedBinariesDir, SIDECAR_MANIFEST_NAME));
  if (platform !== "win32") {
    await fs.chmod(sidecarDest, 0o755);
  }

  let hasWindowsSandbox = false;
  if (platform === "win32") {
    const winSandboxDest = path.join(stagedDir, "windows-sandbox");
    const sandboxManifestSrc = path.join(stagedBinariesSrcDir, WINDOWS_SANDBOX_MANIFEST_NAME);
    if (await pathExists(sandboxManifestSrc)) {
      await fs.mkdir(winSandboxDest, { recursive: true });
      await fs.copyFile(
        sandboxManifestSrc,
        path.join(stagedBinariesDir, WINDOWS_SANDBOX_MANIFEST_NAME),
      );
      await fs.copyFile(
        sandboxManifestSrc,
        path.join(winSandboxDest, WINDOWS_SANDBOX_MANIFEST_NAME),
      );
      for (const fileName of WINDOWS_SANDBOX_FILES) {
        const helperSrc = path.join(stagedBinariesSrcDir, fileName);
        if (await pathExists(helperSrc)) {
          await fs.copyFile(helperSrc, path.join(stagedBinariesDir, fileName));
          await fs.copyFile(helperSrc, path.join(winSandboxDest, fileName));
        }
      }
      hasWindowsSandbox = true;
    }
  }

  const packagingIconsDir = path.join(root, "crates", "cowork-desktop", "packaging", "icons");
  const stagedTrayDir = path.join(stagedDir, "tray");
  await fs.mkdir(stagedTrayDir, { recursive: true });
  await fs.copyFile(path.join(packagingIconsDir, "icon.png"), path.join(stagedTrayDir, "icon.png"));
  await fs.copyFile(path.join(packagingIconsDir, "icon.ico"), path.join(stagedTrayDir, "icon.ico"));

  return { hasWindowsSandbox };
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export async function refreshWindowsSandboxHashManifests(stagedDir: string): Promise<void> {
  for (const dir of [path.join(stagedDir, "binaries"), path.join(stagedDir, "windows-sandbox")]) {
    const manifestPath = path.join(dir, WINDOWS_SANDBOX_MANIFEST_NAME);
    if (!(await pathExists(manifestPath))) {
      continue;
    }
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      schemaVersion?: number;
      rustTarget?: string;
      files?: Record<string, string>;
    };
    if (parsed.schemaVersion !== 1 || !parsed.files || typeof parsed.files !== "object") {
      throw new Error(`Unsupported Windows sandbox hash manifest at ${manifestPath}.`);
    }
    const nextFiles: Record<string, string> = {};
    for (const fileName of Object.keys(parsed.files)) {
      const targetPath = path.join(dir, fileName);
      if (!(await pathExists(targetPath))) {
        throw new Error(`Missing staged Windows sandbox binary: ${targetPath}`);
      }
      nextFiles[fileName] = await sha256File(targetPath);
    }
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ schemaVersion: 1, rustTarget: parsed.rustTarget, files: nextFiles }, null, 2)}\n`,
      "utf8",
    );
  }
}

async function findCargoPackagerBin(env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.CARGO_PACKAGER_BIN?.trim();
  if (override) return override;
  const fromPath = which("cargo-packager", { env });
  if (fromPath) return fromPath;
  const cargoBin = path.join(
    home(env),
    ".cargo",
    "bin",
    hostPlatform() === "win32" ? "cargo-packager.exe" : "cargo-packager",
  );
  if (await pathExists(cargoBin)) return cargoBin;
  throw new Error(
    "cargo-packager CLI not found. Install it with: cargo install cargo-packager --version 0.11.8 --locked",
  );
}

export interface ResolvedWindowsSigningInput {
  kind: "command" | "thumbprint" | "pfx" | "none";
  signCommand?: string;
  thumbprint?: string;
  pfx?: string;
  pfxPassword?: string;
}

/**
 * Resolves Windows Authenticode signing inputs strictly from Windows-specific variables.
 * Never falls back to `CSC_LINK` / `CSC_KEY_PASSWORD` (which hold the macOS Apple Developer ID
 * certificate in multi-platform CI workflows).
 */
export function resolveWindowsSigningInput(env: NodeJS.ProcessEnv): ResolvedWindowsSigningInput {
  const explicitCommand =
    env.CARGO_PACKAGER_WINDOWS_SIGN_COMMAND?.trim() || env.WINDOWS_SIGN_COMMAND?.trim();
  if (explicitCommand) {
    return { kind: "command", signCommand: explicitCommand };
  }

  const explicitThumbprint = env.WINDOWS_CERTIFICATE_THUMBPRINT?.trim();
  if (explicitThumbprint) {
    return { kind: "thumbprint", thumbprint: explicitThumbprint };
  }

  const rawPfx = env.WIN_CSC_LINK?.trim();
  if (rawPfx) {
    return {
      kind: "pfx",
      pfx: rawPfx,
      pfxPassword: env.WIN_CSC_KEY_PASSWORD ?? "",
    };
  }

  return { kind: "none" };
}

async function prepareWindowsAuthenticode(
  env: NodeJS.ProcessEnv,
  stagedDir: string,
  tempDir: string,
): Promise<{
  thumbprint?: string;
  signCommand?: string;
  cleanup?: () => Promise<void>;
}> {
  const resolved = resolveWindowsSigningInput(env);
  if (resolved.kind === "command" && resolved.signCommand) {
    await signStagedWindowsExesWithCommand(stagedDir, resolved.signCommand);
    await refreshWindowsSandboxHashManifests(stagedDir);
    return { signCommand: resolved.signCommand };
  }

  if (resolved.kind === "thumbprint" && resolved.thumbprint) {
    await signStagedWindowsExesWithThumbprint(stagedDir, resolved.thumbprint, env);
    await refreshWindowsSandboxHashManifests(stagedDir);
    return { thumbprint: resolved.thumbprint };
  }

  if (resolved.kind !== "pfx" || !resolved.pfx) {
    return {};
  }

  const rawPfx = resolved.pfx;
  const pfxPassword = resolved.pfxPassword ?? "";

  const pfxPath = path.join(tempDir, `cowork-win-sign-${process.pid}.pfx`);
  if (fsSync.existsSync(rawPfx)) {
    await fs.copyFile(rawPfx, pfxPath);
  } else {
    await fs.writeFile(pfxPath, Buffer.from(rawPfx.replace(/\s+/g, ""), "base64"), {
      mode: 0o600,
    });
  }

  const importScript = [
    "$ErrorActionPreference = 'Stop'",
    "$pw = if ($env:COWORK_PFX_PASS) { ConvertTo-SecureString $env:COWORK_PFX_PASS -AsPlainText -Force } else { $null }",
    "$cert = Import-PfxCertificate -FilePath $env:COWORK_PFX_PATH -CertStoreLocation 'Cert:\\CurrentUser\\My' -Password $pw",
    "Write-Output $cert.Thumbprint",
  ].join("; ");

  const importResult = await execSpawn(["pwsh", "-NoProfile", "-Command", importScript], {
    env: {
      ...env,
      COWORK_PFX_PATH: pfxPath,
      COWORK_PFX_PASS: pfxPassword,
    },
    captureOutput: true,
  });
  const thumbprint = importResult.stdout.trim().split(/\r?\n/).pop()?.trim();
  if (!thumbprint) {
    await fs.rm(pfxPath, { force: true });
    throw new Error("Failed to import Windows signing certificate into Cert:\\CurrentUser\\My.");
  }

  try {
    await signStagedWindowsExesWithThumbprint(stagedDir, thumbprint, env);
    await refreshWindowsSandboxHashManifests(stagedDir);
  } catch (err) {
    await removeWindowsCert(thumbprint, pfxPath);
    throw err;
  }

  return {
    thumbprint,
    cleanup: async () => removeWindowsCert(thumbprint, pfxPath),
  };
}

async function removeWindowsCert(thumbprint: string, pfxPath: string): Promise<void> {
  await execSpawn(
    [
      "pwsh",
      "-NoProfile",
      "-Command",
      `Get-ChildItem -Path "Cert:\\CurrentUser\\My\\${thumbprint}" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue`,
    ],
    { allowFailure: true },
  );
  await fs.rm(pfxPath, { force: true });
}

async function listStagedWindowsExes(stagedDir: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const subdir of ["binaries", "windows-sandbox"]) {
    const dir = path.join(stagedDir, subdir);
    if (!(await pathExists(dir))) continue;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
        candidates.push(path.join(dir, entry.name));
      }
    }
  }
  return candidates;
}

async function findWindowsSigntool(env: NodeJS.ProcessEnv): Promise<string> {
  const fromPath =
    which("signtool.exe", { env, platform: "win32" }) ??
    which("signtool", { env, platform: "win32" });
  if (fromPath) return fromPath;
  const kitRoot = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (await pathExists(kitRoot)) {
    const versions = (await fs.readdir(kitRoot)).sort().reverse();
    for (const ver of versions) {
      const candidate = path.join(kitRoot, ver, "x64", "signtool.exe");
      if (await pathExists(candidate)) return candidate;
    }
  }
  throw new Error("Windows signtool.exe not found on PATH or in Windows Kits 10.");
}

async function signStagedWindowsExesWithThumbprint(
  stagedDir: string,
  thumbprint: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const signtool = await findWindowsSigntool(env);
  const timestampUrl = env.WINDOWS_TIMESTAMP_URL?.trim() || "http://timestamp.digicert.com";
  const exes = await listStagedWindowsExes(stagedDir);
  for (const exePath of exes) {
    await runCommand(
      [
        signtool,
        "sign",
        "/fd",
        "sha256",
        "/sha1",
        thumbprint,
        "/tr",
        timestampUrl,
        "/td",
        "sha256",
        exePath,
      ],
      { cwd: stagedDir, env },
    );
  }
}

async function signStagedWindowsExesWithCommand(
  stagedDir: string,
  commandTemplate: string,
): Promise<void> {
  const exes = await listStagedWindowsExes(stagedDir);
  for (const exePath of exes) {
    const expanded = commandTemplate.replaceAll("%1", exePath);
    await runCommand(["pwsh", "-NoProfile", "-Command", expanded], { cwd: stagedDir });
  }
}

async function notarizeAndStapleDmg(
  dmgPath: string,
  macSigningEnv: Record<string, string>,
): Promise<void> {
  const args = ["xcrun", "notarytool", "submit", dmgPath, "--wait"];
  if (
    macSigningEnv.APPLE_API_KEY &&
    macSigningEnv.APPLE_API_KEY_PATH &&
    macSigningEnv.APPLE_API_ISSUER
  ) {
    args.push(
      "--key",
      macSigningEnv.APPLE_API_KEY_PATH,
      "--key-id",
      macSigningEnv.APPLE_API_KEY,
      "--issuer",
      macSigningEnv.APPLE_API_ISSUER,
    );
  } else if (
    macSigningEnv.APPLE_ID &&
    macSigningEnv.APPLE_PASSWORD &&
    macSigningEnv.APPLE_TEAM_ID
  ) {
    args.push(
      "--apple-id",
      macSigningEnv.APPLE_ID,
      "--password",
      macSigningEnv.APPLE_PASSWORD,
      "--team-id",
      macSigningEnv.APPLE_TEAM_ID,
    );
  } else if (macSigningEnv.APPLE_KEYCHAIN_PROFILE) {
    args.push("--keychain-profile", macSigningEnv.APPLE_KEYCHAIN_PROFILE);
  } else {
    return;
  }

  console.log(`[package] Notarizing DMG: ${path.basename(dmgPath)}`);
  const dmgDir = path.dirname(dmgPath);
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runCommand(args, { cwd: dmgDir, env: { ...process.env, ...macSigningEnv } });
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delayMs = attempt * 5000;
        console.warn(
          `[package] notarytool submit attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs / 1000}s...`,
        );
        await Bun.sleep(delayMs);
      }
    }
  }
  if (lastError !== undefined) {
    throw lastError;
  }
  await runCommand(["xcrun", "stapler", "staple", dmgPath], { cwd: dmgDir });
}

async function normalizeGeneratedInstallerName(
  outDir: string,
  suffix: string,
  targetFileName: string,
): Promise<string | null> {
  const entries = await fs.readdir(outDir);
  const existing = entries.find((name) => name.endsWith(suffix));
  if (!existing) return null;
  if (existing === targetFileName) return path.join(outDir, existing);
  const srcPath = path.join(outDir, existing);
  const destPath = path.join(outDir, targetFileName);
  await fs.rename(srcPath, destPath);
  return destPath;
}

async function signUpdaterPayloadWithMinisign(params: {
  cargoPackagerBin: string;
  payloadPath: string;
  privateKey: string;
  password?: string;
}): Promise<string> {
  const signEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") signEnv[k] = v;
  }
  signEnv.CARGO_PACKAGER_SIGN_PRIVATE_KEY = params.privateKey;
  if (params.password !== undefined) {
    signEnv.CARGO_PACKAGER_SIGN_PRIVATE_KEY_PASSWORD = params.password;
  }
  await runCommand([params.cargoPackagerBin, "signer", "sign", params.payloadPath], {
    cwd: path.dirname(params.payloadPath),
    env: signEnv,
  });
  const sigPath = `${params.payloadPath}.sig`;
  if (!(await pathExists(sigPath))) {
    throw new Error(`Expected signature file was not created: ${sigPath}`);
  }
  const signature = (await fs.readFile(sigPath, "utf8")).trim();
  if (!signature) {
    throw new Error(`Generated Minisign signature file is empty: ${sigPath}`);
  }
  return signature;
}

export async function runRunePackage(
  options: { root?: string; argv?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
) {
  const root = options.root ?? defaultRoot;
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const currentHostPlatform = hostPlatform();
  const currentHostArch = hostArch();
  const cli = parsePackageCliArgs(argv, env, currentHostPlatform, currentHostArch);

  if (cli.platform !== currentHostPlatform) {
    throw new Error(
      `Cross-OS packaging (${cli.platform} on ${currentHostPlatform} host) is not supported; run on a matching OS host.`,
    );
  }

  const version = await resolvePackageVersion(root, cli.version, env);
  const rustTarget = resolveRustCompileTarget(cli.platform, cli.arch);
  const platformKey = resolvePlatformKey(cli.platform, cli.arch);
  const isCrossArch = cli.arch !== currentHostArch || cli.forceCargoTarget;
  const cargoTargetDir = env.CARGO_TARGET_DIR?.trim()
    ? path.resolve(root, env.CARGO_TARGET_DIR.trim())
    : path.join(root, "target");

  const binariesDir = cli.binariesDir
    ? path.resolve(root, cli.binariesDir)
    : isCrossArch
      ? path.join(cargoTargetDir, rustTarget, "release")
      : path.join(cargoTargetDir, "release");

  const workDir = cli.outDir
    ? path.resolve(root, cli.outDir)
    : path.join(cargoTargetDir, "rune-package", platformKey);
  const outDir = path.join(workDir, "out");
  const stagedDir = path.join(workDir, "staged");

  const cargoPackagerBin = await findCargoPackagerBin(env);
  const buildEnv = resolveCargoBuildEnv(env, version);
  const minisignKey = env.CARGO_PACKAGER_SIGN_PRIVATE_KEY?.trim();
  const minisignPassword = env.CARGO_PACKAGER_SIGN_PRIVATE_KEY_PASSWORD;

  validateUpdaterSignKeys({
    requireSign: cli.requireSign,
    skipSign: cli.skipSign,
    minisignPrivateKey: minisignKey,
    updaterPublicKey: buildEnv.COWORK_UPDATER_PUBKEY,
  });

  if (!cli.skipBuild) {
    const cargoArgs = ["cargo", "build", "-p", "cowork-desktop", "--release"];
    if (isCrossArch) {
      await runCommand(["rustup", "target", "add", rustTarget], { cwd: root, env: buildEnv });
      cargoArgs.push("--target", rustTarget);
    }
    console.log(`[package] Building cowork-desktop (${rustTarget}, v${version})...`);
    await runCommand(cargoArgs, { cwd: root, env: buildEnv });
  }

  const mainBinName = cli.platform === "win32" ? "cowork-desktop.exe" : "cowork-desktop";
  const mainBinPath = path.join(binariesDir, mainBinName);
  if (!(await pathExists(mainBinPath))) {
    throw new Error(`Missing built cowork-desktop binary at ${mainBinPath}.`);
  }

  if (!cli.skipResources) {
    console.log(`[package] Staging runtime resources (${cli.platform}/${cli.arch})...`);
    await runCommand(
      [
        "bun",
        "run",
        path.join(root, "scripts", "build_desktop_resources.ts"),
        `--platform=${cli.platform}`,
        `--arch=${cli.arch}`,
      ],
      { cwd: root, env: buildEnv },
    );
  }

  await fs.mkdir(workDir, { recursive: true });
  await rmrf(outDir);
  await fs.mkdir(outDir, { recursive: true });

  const { hasWindowsSandbox } = await stageRuntimeResources({
    root,
    platform: cli.platform,
    rustTarget,
    stagedDir,
  });

  let macSigning: ResolvedMacSigningCredentials = {
    env: {},
    hasCertificate: false,
    hasNotarizeCredentials: false,
    tempFilesToCleanup: [],
  };
  let windowsCleanup: (() => Promise<void>) | undefined;
  let windowsCertificateThumbprint: string | undefined;
  let windowsSignCommand: string | undefined;

  try {
    if (!cli.skipSign && cli.platform === "darwin") {
      macSigning = await prepareMacSigningEnv(env, {
        tempDir: workDir,
        skipNotarize: cli.skipNotarize,
      });
      if (cli.requireSign && (!macSigning.hasCertificate || !macSigning.signingIdentity)) {
        throw new Error(
          "--require-sign specified, but macOS signing certificate/identity is missing.",
        );
      }
      if (cli.requireSign && !cli.skipNotarize && !macSigning.hasNotarizeCredentials) {
        throw new Error(
          "--require-sign specified, but Apple notarization credentials are missing.",
        );
      }
    } else if (!cli.skipSign && cli.platform === "win32") {
      const winSign = await prepareWindowsAuthenticode(env, stagedDir, workDir);
      windowsCertificateThumbprint = winSign.thumbprint;
      windowsSignCommand = winSign.signCommand;
      windowsCleanup = winSign.cleanup;
      if (cli.requireSign && !windowsCertificateThumbprint && !windowsSignCommand) {
        throw new Error(
          "--require-sign specified, but Windows signing credentials (WIN_CSC_LINK/WINDOWS_CERTIFICATE_THUMBPRINT) are missing.",
        );
      }
    }

    let packagerBinariesDir = binariesDir;
    if (cli.platform === "darwin") {
      // Stage the compiled Rust binary under the historical macOS executable name
      // (`Cowork`) so cargo-packager emits `Cowork.app/Contents/MacOS/Cowork`
      // and `CFBundleExecutable = Cowork` before inside-out codesigning/notarization.
      const macosBinariesDir = path.join(workDir, "macos-binaries");
      await rmrf(macosBinariesDir);
      await fs.mkdir(macosBinariesDir, { recursive: true });
      const stagedMacMainBin = path.join(macosBinariesDir, EXPECTED_MAC_EXECUTABLE_NAME);
      await fs.copyFile(mainBinPath, stagedMacMainBin);
      await fs.chmod(stagedMacMainBin, 0o755);
      packagerBinariesDir = macosBinariesDir;
    }

    const baseConfig = await loadPackagerBaseConfig(root);
    const resolvedConfig = buildPackagerConfig({
      root,
      baseConfig,
      version,
      outDir,
      binariesDir: packagerBinariesDir,
      stagedDir,
      targetTriple: rustTarget,
      includeWindowsSandbox: hasWindowsSandbox,
      macosSigningIdentity: macSigning.signingIdentity,
      windowsCertificateThumbprint,
      windowsSignCommand,
    });

    const configPath = path.join(workDir, "packager.config.json");
    if (
      cli.platform === "win32" &&
      cli.formats.includes("nsis") &&
      typeof resolvedConfig.nsis?.template === "string"
    ) {
      const templateText = await fs.readFile(resolvedConfig.nsis.template, "utf8");
      validateMigrationNsisTemplate(templateText);
    }
    await fs.writeFile(configPath, `${JSON.stringify(resolvedConfig, null, 2)}\n`, "utf8");

    console.log(
      `[package] Running cargo-packager (${platformKey}, formats: ${cli.formats.join(",")})...`,
    );
    await runCommand(
      [cargoPackagerBin, "--config", configPath, "--formats", cli.formats.join(",")],
      {
        cwd: root,
        env: buildCargoPackagerEnv({
          buildEnv,
          macSigningEnv: macSigning.env,
          skipNotarize: cli.skipSign || cli.skipNotarize,
        }),
      },
    );

    const artifacts: string[] = [];
    let legacyMacChannelPath: string | null = null;
    let legacyMacZipSummary: { fileName: string; sha512: string; size: number } | null = null;
    let legacyWindowsChannelPath: string | null = null;
    let legacyWindowsInstallerSummary: { fileName: string; sha512: string; size: number } | null =
      null;
    if (cli.platform === "darwin") {
      const normArch = normalizeArchName(cli.arch);
      const appPath = path.join(outDir, "Cowork.app");
      const names = resolveMacArchiveNames(normArch, version);
      const dmgPath = path.join(outDir, names.dmgName);

      if (await pathExists(dmgPath)) {
        if (!cli.skipSign && !cli.skipNotarize && macSigning.hasNotarizeCredentials) {
          await notarizeAndStapleDmg(dmgPath, macSigning.env);
        }
        artifacts.push(dmgPath);
      }

      if (await pathExists(appPath)) {
        artifacts.push(appPath);
        const zipPath = path.join(outDir, names.zipName);
        await runCommand(
          ["ditto", "-c", "-k", "--keepParent", "--sequesterRsrc", appPath, zipPath],
          { cwd: outDir },
        );
        artifacts.push(zipPath);

        const tarGzPath = path.join(outDir, names.updaterTarGzName);
        await runCommand(["tar", "-czf", tarGzPath, "-C", outDir, "Cowork.app"], {
          cwd: outDir,
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        });
        artifacts.push(tarGzPath);

        legacyMacChannelPath = path.join(outDir, LEGACY_MAC_CHANNEL_FILENAME);
        const { metadata: legacyMacMetadata } = await writeLegacyMacChannelFile({
          version,
          zipPaths: [zipPath],
          outPath: legacyMacChannelPath,
          requiredArches: [normArch],
        });
        artifacts.push(legacyMacChannelPath);
        const primaryZipEntry = legacyMacMetadata.files[0];
        if (primaryZipEntry) {
          legacyMacZipSummary = {
            fileName: primaryZipEntry.url,
            sha512: primaryZipEntry.sha512,
            size: primaryZipEntry.size,
          };
        }

        const shouldVerifyMacSign = !cli.skipSign && Boolean(macSigning.signingIdentity);
        const shouldVerifyMacNotarize =
          shouldVerifyMacSign && !cli.skipNotarize && macSigning.hasNotarizeCredentials;
        await verifyMacReleaseOutputs({
          outDir,
          version,
          arch: normArch,
          requireSigned: shouldVerifyMacSign,
          requireNotarized: shouldVerifyMacNotarize,
          requireUpdaterTarGz: true,
          requireDmg: cli.formats.includes("dmg"),
          verifyLatestMacYmlPath: legacyMacChannelPath,
        });
      }
    } else if (cli.platform === "win32") {
      const normArch = normalizeArchName(cli.arch) === "arm64" ? "arm64" : "x64";
      const targetExeName = resolveLegacyWindowsInstallerName(normArch, version);
      const renamedExe = await normalizeGeneratedInstallerName(outDir, "-setup.exe", targetExeName);
      if (renamedExe) {
        artifacts.push(renamedExe);
        legacyWindowsChannelPath = path.join(outDir, resolveLegacyWindowsChannelFilename(normArch));
        const { metadata: legacyWindowsMetadata } = await writeLegacyWindowsChannelFile({
          version,
          arch: normArch,
          installerPath: renamedExe,
          outPath: legacyWindowsChannelPath,
        });
        artifacts.push(legacyWindowsChannelPath);
        const primaryExeEntry = legacyWindowsMetadata.files[0];
        if (primaryExeEntry) {
          legacyWindowsInstallerSummary = {
            fileName: primaryExeEntry.url,
            sha512: primaryExeEntry.sha512,
            size: primaryExeEntry.size,
          };
        }

        const shouldVerifyWindowsSign =
          !cli.skipSign && Boolean(windowsCertificateThumbprint || windowsSignCommand);
        await verifyWindowsReleaseOutputs({
          outDir,
          version,
          arch: normArch,
          stagedDir,
          binariesDir: packagerBinariesDir,
          verifyChannelYmlPath: legacyWindowsChannelPath,
          requireSigned: shouldVerifyWindowsSign,
          expectedPublisher: env.WINDOWS_SIGN_PUBLISHER?.trim() || undefined,
        });
      }
      const renamedMsi = await normalizeGeneratedInstallerName(
        outDir,
        ".msi",
        `Cowork_${version}_${normArch}.msi`,
      );
      if (renamedMsi) artifacts.push(renamedMsi);
    } else if (cli.platform === "linux") {
      const linuxArch = normalizeArchName(cli.arch) === "arm64" ? "aarch64" : "x86_64";
      const renamedAppImage = await normalizeGeneratedInstallerName(
        outDir,
        ".AppImage",
        `Cowork_${version}_${linuxArch}.AppImage`,
      );
      if (renamedAppImage) artifacts.push(renamedAppImage);
      for (const entry of await fs.readdir(outDir)) {
        if (entry.endsWith(".deb")) {
          artifacts.push(path.join(outDir, entry));
        }
      }
    }

    const updaterDescriptor = resolveUpdaterPayloadDescriptor(
      cli.platform,
      cli.arch,
      version,
      cli.formats,
    );
    let updaterFragmentPath: string | null = null;
    if (!cli.skipSign && minisignKey && updaterDescriptor) {
      const payloadPath = path.join(outDir, updaterDescriptor.fileName);
      if (!(await pathExists(payloadPath))) {
        throw new Error(`Expected updater payload not found for signing: ${payloadPath}`);
      }
      console.log(`[package] Minisign signing updater payload: ${updaterDescriptor.fileName}`);
      const signature = await signUpdaterPayloadWithMinisign({
        cargoPackagerBin,
        payloadPath,
        privateKey: minisignKey,
        password: minisignPassword,
      });
      artifacts.push(`${payloadPath}.sig`);
      const fragment: UpdaterFragment = {
        platformKey,
        version,
        format: updaterDescriptor.format,
        fileName: updaterDescriptor.fileName,
        signature,
      };
      updaterFragmentPath = path.join(outDir, `updater-fragment-${platformKey}.json`);
      await fs.writeFile(updaterFragmentPath, `${JSON.stringify(fragment, null, 2)}\n`, "utf8");
    }

    const summary = {
      platformKey,
      rustTarget,
      version,
      outDir,
      stagedDir,
      signedPlatform:
        cli.platform === "darwin"
          ? Boolean(macSigning.signingIdentity)
          : cli.platform === "win32"
            ? Boolean(windowsCertificateThumbprint || windowsSignCommand)
            : false,
      notarized:
        cli.platform === "darwin" && !cli.skipNotarize && macSigning.hasNotarizeCredentials,
      signedUpdater: Boolean(updaterFragmentPath),
      artifacts: artifacts.map((item) => path.basename(item)),
      updaterFragment: updaterFragmentPath ? path.basename(updaterFragmentPath) : null,
      legacyMacChannel: legacyMacChannelPath ? path.basename(legacyMacChannelPath) : null,
      legacyMacZip: legacyMacZipSummary,
      legacyWindowsChannel: legacyWindowsChannelPath
        ? path.basename(legacyWindowsChannelPath)
        : null,
      legacyWindowsInstaller: legacyWindowsInstallerSummary,
    };
    await fs.writeFile(
      path.join(outDir, `package-summary-${platformKey}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
    console.log(`[package] Complete (${platformKey}): ${outDir}`);
    for (const item of summary.artifacts) {
      console.log(`  - ${item}`);
    }
    return summary;
  } finally {
    await windowsCleanup?.();
    for (const tempFile of macSigning.tempFilesToCleanup) {
      await fs.rm(tempFile, { force: true });
    }
  }
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      [
        "Usage: bun run desktop:rune:package -- [options]",
        "",
        "Options:",
        "  --target <os-arch|triple>   Target platform (default: host OS/arch)",
        "  --platform <darwin|win32|linux>",
        "  --arch <arm64|x64>",
        "  --formats <a,b>             Comma-separated cargo-packager formats",
        "  --version <semver>          Override package version",
        "  --print-version             Print resolved package version and exit",
        "  --out-dir <path>            Override output root directory",
        "  --binaries-dir <path>       Override compiled binary directory",
        "  --skip-build                Reuse existing release binary",
        "  --skip-resources            Reuse existing dist/ and staged sidecar",
        "  --skip-sign / --unsigned    Skip codesign, notarization, and Minisign",
        "  --skip-notarize             Codesign without Apple notarization",
        "  --require-sign              Fail if required signing keys are missing",
      ].join("\n"),
    );
    process.exit(0);
  }
  if (process.argv.includes("--print-version")) {
    const cli = parsePackageCliArgs(process.argv.slice(2));
    const version = await resolvePackageVersion(defaultRoot, cli.version, process.env);
    console.log(version);
    process.exit(0);
  }
  await runRunePackage().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
