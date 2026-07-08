import fs from "node:fs";
import path from "node:path";

import { getEnv, readPathValue, splitPathValue } from "./env";
import { hostPlatform } from "./host";
import { type EnvRecord, pathImplForPlatform } from "./pathImpl";

/**
 * How a resolved executable must be spawned. win32 classifies by extension:
 * `.cmd`/`.bat` are cmd.exe batch shims, `.ps1` needs a PowerShell host, all
 * else is native. POSIX is always "native" (shebang scripts execute directly).
 * "script" is reserved for future POSIX interpreter-script classification.
 */
export type ExecutableKind = "native" | "batch-shim" | "powershell-script" | "script";

/**
 * The shim-aware spawn recipe returned by resolveSpawn. When
 * `windowsVerbatimArguments` is true (win32 batch shims only), the spawner
 * MUST pass args verbatim (no re-quoting) or the cmd.exe payload is corrupted.
 */
export type SpawnPlan = {
  file: string;
  args: string[];
  kind: ExecutableKind;
  windowsVerbatimArguments?: boolean;
};

/**
 * Thrown by resolveSpawn when a batch-shim argument (or the shim path itself)
 * contains a cmd.exe hazard that cannot be safely neutralized (CVE-2024-24576
 * "BatBadBut" class). Never silently mangles; `argument` names the offender.
 */
export class UnsafeShimArgumentError extends Error {
  readonly argument: string;

  constructor(argument: string, reason: string) {
    super(`Unsafe batch-shim argument ${JSON.stringify(argument)}: ${reason}`);
    this.name = "UnsafeShimArgumentError";
    this.argument = argument;
  }
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function pathextExtensions(env: EnvRecord, platform: NodeJS.Platform): string[] {
  const raw = getEnv(env, "PATHEXT", platform);
  const effective = raw && raw.trim().length > 0 ? raw : DEFAULT_PATHEXT;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of effective.split(";")) {
    const trimmed = part.trim().toLowerCase();
    if (!trimmed) continue;
    const ext = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out;
}

/**
 * Ordered file-name candidates for an executable name. win32: the bare name
 * first (so explicit extensions resolve exactly), then PATHEXT-derived
 * lowercased extensions in PATHEXT order (default ".COM;.EXE;.BAT;.CMD",
 * empty/blank PATHEXT falls back to the default). POSIX: [name] — no
 * extension probing ever.
 */
export function executableCandidates(
  name: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string[] {
  const platform = opts.platform ?? hostPlatform();
  if (platform !== "win32") return [name];
  const env = opts.env ?? process.env;
  const candidates = [name];
  const seen = new Set([name.toLowerCase()]);
  for (const ext of pathextExtensions(env, platform)) {
    const candidate = `${name}${ext}`;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

function defaultExists(platform: NodeJS.Platform): (p: string) => boolean {
  return (p: string): boolean => {
    try {
      if (!fs.statSync(p).isFile()) return false;
      if (platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

function pathDirKey(dir: string, platform: NodeJS.Platform): string {
  const pathImpl = pathImplForPlatform(platform);
  let normalized = pathImpl.normalize(dir);
  const root = pathImpl.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(pathImpl.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * THE executable resolver. win32: case-insensitive PATH env key, quote-aware
 * PATH split, PATHEXT candidates per directory (directory order wins over
 * extension order, matching cmd.exe). POSIX: exact "PATH" key, ":" split, no
 * extension probing. Absolute candidates are existence-checked and returned
 * without a PATH scan; names containing a separator resolve against `cwd`
 * (never PATH-searched). `skipDirs` excludes PATH entries (case-folded and
 * separator-normalized comparison on win32; exact on POSIX). `exists` is
 * injectable for tests; the default checks isFile (plus X_OK on POSIX).
 */
export function which(
  name: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    platform?: NodeJS.Platform;
    exists?: (p: string) => boolean;
    skipDirs?: string[];
  } = {},
): string | null {
  const platform = opts.platform ?? hostPlatform();
  if (!name) return null;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? defaultExists(platform);
  const pathImpl = pathImplForPlatform(platform);

  const hasSeparator = name.includes("/") || (platform === "win32" && name.includes("\\"));
  if (pathImpl.isAbsolute(name) || hasSeparator) {
    const base = pathImpl.isAbsolute(name)
      ? name
      : opts.cwd
        ? pathImpl.resolve(opts.cwd, name)
        : name;
    for (const candidate of executableCandidates(base, { env, platform })) {
      if (exists(candidate)) return candidate;
    }
    return null;
  }

  const candidates = executableCandidates(name, { env, platform });
  const skip = new Set((opts.skipDirs ?? []).map((dir) => pathDirKey(dir, platform)));
  for (const dir of splitPathValue(readPathValue(env, platform), platform)) {
    if (skip.has(pathDirKey(dir, platform))) continue;
    for (const candidate of candidates) {
      const full = pathImpl.join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * Extension-based spawn classification. win32: ".cmd"/".bat" → "batch-shim"
 * (must be wrapped via resolveSpawn — direct shell-less spawn fails or is
 * unsafe), ".ps1" → "powershell-script", anything else → "native". POSIX:
 * always "native" — script shebangs execute natively there.
 */
export function classifyExecutable(
  p: string,
  platform: NodeJS.Platform = hostPlatform(),
): ExecutableKind {
  if (platform !== "win32") return "native";
  const ext = path.win32.extname(p).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return "batch-shim";
  if (ext === ".ps1") return "powershell-script";
  return "native";
}

/**
 * Platform binary file name for managed installs: appends ".exe" on win32
 * (idempotent — an existing ".exe" suffix of any case is kept as-is); returns
 * the base name unchanged on POSIX.
 */
export function binaryName(base: string, platform: NodeJS.Platform = hostPlatform()): string {
  if (platform !== "win32") return base;
  return base.toLowerCase().endsWith(".exe") ? base : `${base}.exe`;
}

function assertSafeBatchShimValue(value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new UnsafeShimArgumentError(
      value,
      "contains a line break or NUL, which would truncate or split the cmd.exe command line",
    );
  }
  if (value.includes('"')) {
    throw new UnsafeShimArgumentError(
      value,
      "contains a double quote, which cannot be safely represented across cmd.exe and " +
        "MSVCRT argument parsing",
    );
  }
  const firstPercent = value.indexOf("%");
  if (firstPercent !== -1 && value.indexOf("%", firstPercent + 1) !== -1) {
    throw new UnsafeShimArgumentError(
      value,
      "contains a %VAR%-expandable sequence, which cmd.exe expands even inside quotes",
    );
  }
}

function quoteBatchShimValue(value: string): string {
  assertSafeBatchShimValue(value);
  // Double every trailing backslash so the closing quote survives MSVCRT-style
  // re-parsing by whatever the shim forwards %* to (node.exe etc.).
  const trailing = value.match(/\\+$/);
  const body = trailing ? value + trailing[0] : value;
  return `"${body}"`;
}

/**
 * THE shim-aware pre-spawn step. POSIX: identity ({ file, args } untouched,
 * kind "native"). win32: resolves bare names via which(); batch shims are
 * wrapped as `cmd.exe /d /s /v:off /c "<quoted payload>"` (cmd.exe from
 * COMSPEC, falling back to "cmd.exe") with BatBadBut-safe quoting — every arg
 * is double-quoted (making & | < > ^ literal per cmd semantics), trailing
 * backslashes are doubled, `/v:off` pins `!` literal, and args with double
 * quotes, %VAR%-expandable sequences, or line breaks throw a typed
 * UnsafeShimArgumentError instead of being silently mangled. The returned
 * `windowsVerbatimArguments: true` MUST be honored by the spawner. Native
 * binaries and .ps1 scripts use the resolved path when PATH lookup succeeds.
 */
export function resolveSpawn(
  fileOrName: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    platform?: NodeJS.Platform;
    exists?: (p: string) => boolean;
    skipDirs?: string[];
  } = {},
): SpawnPlan {
  const platform = opts.platform ?? hostPlatform();
  if (platform !== "win32") {
    return { file: fileOrName, args: [...args], kind: "native" };
  }
  const resolved = which(fileOrName, { ...opts, platform }) ?? fileOrName;
  const kind = classifyExecutable(resolved, platform);
  if (kind !== "batch-shim") {
    return { file: resolved, args: [...args], kind };
  }
  const env = opts.env ?? process.env;
  const comspec = getEnv(env, "COMSPEC", platform) ?? "cmd.exe";
  const payloadParts = [resolved, ...args].map(quoteBatchShimValue);
  const payload = `"${payloadParts.join(" ")}"`;
  return {
    file: comspec,
    args: ["/d", "/s", "/v:off", "/c", payload],
    kind: "batch-shim",
    windowsVerbatimArguments: true,
  };
}
