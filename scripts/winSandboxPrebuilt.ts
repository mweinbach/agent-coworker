import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractZipArchive, findFileRecursive, pathExists, rmrf } from "./releaseBuildUtils";

export const WIN_SANDBOX_PREBUILT_LOCK_NAME = "prebuilt.lock.json";
export const WIN_SANDBOX_PREBUILT_DISABLE_ENV = "COWORK_WIN_SANDBOX_PREBUILT";
export const WIN_SANDBOX_PREBUILT_BASE_URL_ENV = "COWORK_WIN_SANDBOX_PREBUILT_BASE_URL";
export const WIN_SANDBOX_PREBUILT_REPO_SLUG = "mweinbach/agent-coworker";

// Build inputs only: docs and .gitignore edits must not invalidate the prebuilt lock.
export const WIN_SANDBOX_FINGERPRINT_INPUTS = [
  "Cargo.toml",
  "Cargo.lock",
  "build.rs",
  "codex-windows-sandbox-setup.manifest",
  "src",
  "vendor",
] as const;

export const WIN_SANDBOX_RUST_TARGETS = [
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
] as const;

export type WinSandboxRustTarget = (typeof WIN_SANDBOX_RUST_TARGETS)[number];

export type WinSandboxPrebuiltTarget = {
  zipName: string;
  zipSha256: string;
  files: Record<string, string>;
};

export type WinSandboxPrebuiltLock = {
  schemaVersion: 1;
  tag: string;
  sourceFingerprint: string;
  targets: Partial<Record<WinSandboxRustTarget, WinSandboxPrebuiltTarget>>;
};

const SHA256_HEX = /^[a-f0-9]{64}$/;

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// The repo has no .gitattributes, so checkouts may carry CRLF on Windows. Hash
// normalized bytes so the fingerprint matches across publisher and consumer checkouts.
function normalizeLineEndings(data: Buffer): Buffer {
  if (!data.includes(0x0d)) {
    return data;
  }
  const out = Buffer.alloc(data.length);
  let written = 0;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i]!;
    if (byte === 0x0d) {
      out[written] = 0x0a;
      written += 1;
      if (data[i + 1] === 0x0a) {
        i += 1;
      }
      continue;
    }
    out[written] = byte;
    written += 1;
  }
  return out.subarray(0, written);
}

async function collectFingerprintEntries(
  target: string,
  crateDir: string,
  acc: string[],
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      acc.push(`${toPosixRelative(crateDir, target)}:missing`);
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      await collectFingerprintEntries(path.join(target, entry.name), crateDir, acc);
    }
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  const contentHash = sha256Hex(normalizeLineEndings(await fs.readFile(target)));
  acc.push(`${toPosixRelative(crateDir, target)}:${contentHash}`);
}

function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

export async function computeSourceFingerprint(crateDir: string): Promise<string> {
  const acc: string[] = [];
  for (const input of WIN_SANDBOX_FINGERPRINT_INPUTS) {
    await collectFingerprintEntries(path.join(crateDir, input), crateDir, acc);
  }
  return sha256Hex(Buffer.from(acc.join("\n"), "utf8"));
}

export function parsePrebuiltLock(raw: string): WinSandboxPrebuiltLock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.tag !== "string" ||
    candidate.tag.length === 0 ||
    typeof candidate.sourceFingerprint !== "string" ||
    !SHA256_HEX.test(candidate.sourceFingerprint) ||
    typeof candidate.targets !== "object" ||
    candidate.targets === null
  ) {
    return null;
  }
  const targets: Partial<Record<WinSandboxRustTarget, WinSandboxPrebuiltTarget>> = {};
  for (const [rustTarget, entry] of Object.entries(candidate.targets)) {
    if (!WIN_SANDBOX_RUST_TARGETS.includes(rustTarget as WinSandboxRustTarget)) {
      return null;
    }
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const target = entry as Record<string, unknown>;
    if (
      typeof target.zipName !== "string" ||
      target.zipName.length === 0 ||
      typeof target.zipSha256 !== "string" ||
      !SHA256_HEX.test(target.zipSha256) ||
      typeof target.files !== "object" ||
      target.files === null
    ) {
      return null;
    }
    const files: Record<string, string> = {};
    for (const [name, hash] of Object.entries(target.files)) {
      if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
        return null;
      }
      files[name] = hash;
    }
    if (Object.keys(files).length === 0) {
      return null;
    }
    targets[rustTarget as WinSandboxRustTarget] = {
      zipName: target.zipName,
      zipSha256: target.zipSha256,
      files,
    };
  }
  return {
    schemaVersion: 1,
    tag: candidate.tag,
    sourceFingerprint: candidate.sourceFingerprint,
    targets,
  };
}

export async function readPrebuiltLock(crateDir: string): Promise<WinSandboxPrebuiltLock | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(crateDir, WIN_SANDBOX_PREBUILT_LOCK_NAME), "utf8");
  } catch {
    return null;
  }
  return parsePrebuiltLock(raw);
}

export type PrebuiltMissReason =
  | "disabled"
  | "no-lock"
  | "fingerprint-drift"
  | "target-missing"
  | "download-failed";

export type PrebuiltDownloadResult =
  | { ok: true; files: Record<string, string> }
  | { ok: false; reason: PrebuiltMissReason };

export async function resolvePrebuiltAvailability(opts: {
  crateDir: string;
  rustTarget: string;
  env?: NodeJS.ProcessEnv;
}): Promise<
  | { available: true; lock: WinSandboxPrebuiltLock; target: WinSandboxPrebuiltTarget }
  | { available: false; reason: Exclude<PrebuiltMissReason, "download-failed"> }
> {
  const env = opts.env ?? process.env;
  if (env[WIN_SANDBOX_PREBUILT_DISABLE_ENV] === "0") {
    return { available: false, reason: "disabled" };
  }
  const lock = await readPrebuiltLock(opts.crateDir);
  if (!lock) {
    return { available: false, reason: "no-lock" };
  }
  const fingerprint = await computeSourceFingerprint(opts.crateDir);
  if (fingerprint !== lock.sourceFingerprint) {
    return { available: false, reason: "fingerprint-drift" };
  }
  const target = lock.targets[opts.rustTarget as WinSandboxRustTarget];
  if (!target) {
    return { available: false, reason: "target-missing" };
  }
  return { available: true, lock, target };
}

export async function tryDownloadPrebuiltHelpers(opts: {
  crateDir: string;
  destinationDir: string;
  rustTarget: string;
  binaryNames: readonly string[];
  repoSlug?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  logger?: (message: string) => void;
}): Promise<PrebuiltDownloadResult> {
  const env = opts.env ?? process.env;
  const log = opts.logger ?? (() => {});
  const availability = await resolvePrebuiltAvailability({
    crateDir: opts.crateDir,
    rustTarget: opts.rustTarget,
    env,
  });
  if (!availability.available) {
    return { ok: false, reason: availability.reason };
  }
  const { lock, target } = availability;

  const baseUrl =
    env[WIN_SANDBOX_PREBUILT_BASE_URL_ENV]?.trim() ||
    `https://github.com/${opts.repoSlug ?? WIN_SANDBOX_PREBUILT_REPO_SLUG}/releases/download`;
  const zipUrl = `${baseUrl.replace(/\/$/, "")}/${lock.tag}/${target.zipName}`;

  const fetchImpl = opts.fetchImpl ?? fetch;
  let zipBytes: Buffer;
  try {
    const headers: Record<string, string> = {
      Accept: "application/octet-stream",
      "User-Agent": "agent-coworker-desktop-build",
    };
    const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(zipUrl, { headers });
    if (!response.ok) {
      log(`prebuilt download failed (${response.status} ${response.statusText}): ${zipUrl}`);
      return { ok: false, reason: "download-failed" };
    }
    zipBytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    log(`prebuilt download failed (${error instanceof Error ? error.message : error}): ${zipUrl}`);
    return { ok: false, reason: "download-failed" };
  }

  // From here on, mismatches are hard failures: the lock's source fingerprint matched,
  // so the release asset must contain exactly the bytes the lock promised. A mismatch
  // means a tampered, corrupted, or desynced release asset — never silently rebuild.
  const zipHash = sha256Hex(zipBytes);
  if (zipHash !== target.zipSha256) {
    throw new Error(
      `Prebuilt Windows sandbox zip hash mismatch for ${target.zipName} (${lock.tag}): expected ${target.zipSha256}, got ${zipHash}. Refusing to fall back to a source build; investigate the release asset or set ${WIN_SANDBOX_PREBUILT_DISABLE_ENV}=0 to bypass prebuilt downloads.`,
    );
  }

  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-win-sandbox-prebuilt-"));
  try {
    const archivePath = path.join(scratchDir, target.zipName);
    const extractDir = path.join(scratchDir, "extract");
    await fs.writeFile(archivePath, zipBytes);
    await fs.mkdir(extractDir, { recursive: true });
    await extractZipArchive(archivePath, extractDir);

    const files: Record<string, string> = {};
    const staged: Array<{ name: string; source: string }> = [];
    for (const name of opts.binaryNames) {
      const expected = target.files[name];
      if (typeof expected !== "string") {
        throw new Error(
          `Prebuilt Windows sandbox lock for ${lock.tag} is missing a hash for ${name}`,
        );
      }
      const extracted = await findFileRecursive(extractDir, name);
      if (!extracted) {
        throw new Error(
          `Prebuilt Windows sandbox zip ${target.zipName} (${lock.tag}) does not contain ${name}`,
        );
      }
      const actual = sha256Hex(await fs.readFile(extracted));
      if (actual !== expected) {
        throw new Error(
          `Prebuilt Windows sandbox helper hash mismatch for ${name} (${lock.tag}): expected ${expected}, got ${actual}. Refusing to fall back to a source build; investigate the release asset or set ${WIN_SANDBOX_PREBUILT_DISABLE_ENV}=0 to bypass prebuilt downloads.`,
        );
      }
      files[name] = actual;
      staged.push({ name, source: extracted });
    }

    await fs.mkdir(opts.destinationDir, { recursive: true });
    for (const { name, source } of staged) {
      await fs.copyFile(source, path.join(opts.destinationDir, name));
    }
    log(`downloaded prebuilt helpers from ${lock.tag} (${opts.rustTarget})`);
    return { ok: true, files };
  } finally {
    await rmrf(scratchDir);
  }
}

function defaultCrateDir(): string {
  return path.resolve(import.meta.dirname, "..", "crates", "cowork-win-sandbox");
}

function parseCliFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseRepeatedCliFlag(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) {
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    values.push(value);
  }
  return values;
}

async function cliFingerprint(crateDir: string): Promise<void> {
  console.log(await computeSourceFingerprint(crateDir));
}

async function cliCheck(crateDir: string, argv: string[]): Promise<void> {
  const rustTarget = parseCliFlag(argv, "--target");
  if (!rustTarget) {
    throw new Error("check requires --target <rust-target>");
  }
  const availability = await resolvePrebuiltAvailability({ crateDir, rustTarget });
  if (availability.available) {
    console.log("prebuilt-hit=true");
    console.log("reason=ok");
    console.log(`tag=${availability.lock.tag}`);
    return;
  }
  console.log("prebuilt-hit=false");
  console.log(`reason=${availability.reason}`);
}

async function cliLock(crateDir: string, argv: string[]): Promise<void> {
  const tag = parseCliFlag(argv, "--tag");
  if (!tag) {
    throw new Error("lock requires --tag <win-sandbox-vX.Y.Z>");
  }
  const zipSpecs = parseRepeatedCliFlag(argv, "--zip");
  if (zipSpecs.length === 0) {
    throw new Error("lock requires at least one --zip <rust-target>=<zip-path>");
  }

  const targets: Partial<Record<WinSandboxRustTarget, WinSandboxPrebuiltTarget>> = {};
  for (const spec of zipSpecs) {
    const separator = spec.indexOf("=");
    if (separator === -1) {
      throw new Error(`Invalid --zip value (expected <rust-target>=<zip-path>): ${spec}`);
    }
    const rustTarget = spec.slice(0, separator) as WinSandboxRustTarget;
    const zipPath = spec.slice(separator + 1);
    if (!WIN_SANDBOX_RUST_TARGETS.includes(rustTarget)) {
      throw new Error(`Unsupported rust target in --zip: ${rustTarget}`);
    }
    if (!(await pathExists(zipPath))) {
      throw new Error(`Zip not found: ${zipPath}`);
    }

    const zipBytes = await fs.readFile(zipPath);
    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-win-sandbox-lock-"));
    try {
      const extractDir = path.join(scratchDir, "extract");
      await fs.mkdir(extractDir, { recursive: true });
      await extractZipArchive(path.resolve(zipPath), extractDir);
      const files: Record<string, string> = {};
      for (const name of [
        "cowork-win-sandbox.exe",
        "codex-windows-sandbox-setup.exe",
        "codex-command-runner.exe",
      ]) {
        const extracted = await findFileRecursive(extractDir, name);
        if (!extracted) {
          throw new Error(`Zip ${zipPath} does not contain ${name}`);
        }
        files[name] = sha256Hex(await fs.readFile(extracted));
      }
      targets[rustTarget] = {
        zipName: path.basename(zipPath),
        zipSha256: sha256Hex(zipBytes),
        files,
      };
    } finally {
      await rmrf(scratchDir);
    }
  }

  const lock: WinSandboxPrebuiltLock = {
    schemaVersion: 1,
    tag,
    sourceFingerprint: await computeSourceFingerprint(crateDir),
    targets,
  };
  console.log(JSON.stringify(lock, null, 2));
}

if (import.meta.main) {
  const [subcommand, ...rest] = process.argv.slice(2);
  const crateDir = parseCliFlag(rest, "--crate-dir") ?? defaultCrateDir();
  try {
    switch (subcommand) {
      case "fingerprint":
        await cliFingerprint(crateDir);
        break;
      case "check":
        await cliCheck(crateDir, rest);
        break;
      case "lock":
        await cliLock(crateDir, rest);
        break;
      default:
        throw new Error(
          `Usage: bun scripts/winSandboxPrebuilt.ts <fingerprint|check --target <t>|lock --tag <tag> --zip <t>=<zip>> [--crate-dir <dir>]`,
        );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
