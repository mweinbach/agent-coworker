import { hostPlatform } from "./host";
import { type EnvRecord, pathImplForPlatform } from "./pathImpl";

/**
 * Find the preserved key spelling for an env var. win32: exact match first,
 * then case-insensitive scan (returns the inherited spelling, e.g. "Path").
 * POSIX: exact key only — the environment IS case-sensitive there.
 */
export function findEnvKey(
  env: EnvRecord,
  name: string,
  platform: NodeJS.Platform = hostPlatform(),
): string | undefined {
  if (Object.hasOwn(env, name)) return name;
  if (platform !== "win32") return undefined;
  const lower = name.toLowerCase();
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
}

/**
 * Read an env var. win32: case-insensitive lookup (matches "Path" for "PATH").
 * POSIX: exact-key lookup only — never case-folds on darwin/linux.
 */
export function getEnv(
  env: EnvRecord,
  name: string,
  platform: NodeJS.Platform = hostPlatform(),
): string | undefined {
  const key = findEnvKey(env, name, platform);
  return key === undefined ? undefined : env[key];
}

/**
 * Write an env var in place. win32: writes to the existing key spelling when a
 * case-insensitive match exists (updates "Path" instead of adding "PATH").
 * POSIX: writes the exact key given.
 */
export function setEnv(
  env: EnvRecord,
  name: string,
  value: string,
  platform: NodeJS.Platform = hostPlatform(),
): void {
  const key = findEnvKey(env, name, platform) ?? name;
  env[key] = value;
}

/** PATH entry delimiter: ";" on win32, ":" on every POSIX platform. */
export function pathDelimiter(platform: NodeJS.Platform = hostPlatform()): ";" | ":" {
  return platform === "win32" ? ";" : ":";
}

/**
 * Read the PATH value with platform key semantics (case-insensitive key on
 * win32, exact "PATH" on POSIX). Returns "" when unset on every platform.
 */
export function readPathValue(env: EnvRecord, platform: NodeJS.Platform = hostPlatform()): string {
  return getEnv(env, "PATH", platform) ?? "";
}

/**
 * Split a PATH value into entries. win32: quote-aware — entries may be
 * double-quoted and contain ";"; surrounding quotes are stripped. POSIX: plain
 * ":" split. Empty entries are dropped on every platform.
 */
export function splitPathValue(
  value: string,
  platform: NodeJS.Platform = hostPlatform(),
): string[] {
  if (platform !== "win32") {
    return value.split(":").filter((entry) => entry.length > 0);
  }
  const entries: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ";" && !inQuotes) {
      if (current.length > 0) entries.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) entries.push(current);
  return entries;
}

/**
 * Deduplicate PATH directories preserving first occurrence and its original
 * spelling. win32: case-folded comparison (NTFS paths are case-insensitive);
 * POSIX: exact comparison. Empty entries are dropped.
 */
export function dedupePathDirs(
  dirs: string[],
  platform: NodeJS.Platform = hostPlatform(),
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const key = platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * Return a copy of `env` (string values only) with `dirs` merged into PATH at
 * the given position, deduplicated per platform case semantics. win32: writes
 * back to the inherited PATH key spelling (e.g. "Path"); POSIX: exact "PATH".
 */
export function mergePathDirs(
  env: EnvRecord,
  dirs: string[],
  opts: { position: "prepend" | "append"; platform?: NodeJS.Platform },
): Record<string, string> {
  const platform = opts.platform ?? hostPlatform();
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  const existing = splitPathValue(readPathValue(env, platform), platform);
  const merged = opts.position === "prepend" ? [...dirs, ...existing] : [...existing, ...dirs];
  const value = dedupePathDirs(merged, platform).join(pathDelimiter(platform));
  setEnv(result, "PATH", value, platform);
  return result;
}

/**
 * THE single answer to which PATH directories a cowork runtime install
 * contributes: bin, node dir, python dir, git dir, poppler bin — and
 * <pythonDir>/Scripts on win32 ONLY (pip installs console scripts there;
 * POSIX pythons put them next to the interpreter). Deduplicated, ordered.
 */
export function runtimePathDirs(
  runtime: { bin?: string; node?: string; python?: string; git?: string; popplerBin?: string },
  platform: NodeJS.Platform = hostPlatform(),
): string[] {
  const pathImpl = pathImplForPlatform(platform);
  const dirs: string[] = [];
  if (runtime.bin) dirs.push(runtime.bin);
  if (runtime.node) dirs.push(pathImpl.dirname(runtime.node));
  if (runtime.python) {
    const pythonDir = pathImpl.dirname(runtime.python);
    dirs.push(pythonDir);
    if (platform === "win32") dirs.push(pathImpl.join(pythonDir, "Scripts"));
  }
  if (runtime.git) dirs.push(pathImpl.dirname(runtime.git));
  if (runtime.popplerBin) dirs.push(runtime.popplerBin);
  return dedupePathDirs(dirs, platform);
}

const WIN32_CHILD_ENV_NAMES = [
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "TEMP",
  "TMP",
  "NUMBER_OF_PROCESSORS",
] as const;

const POSIX_CHILD_ENV_NAMES = ["PATH", "HOME", "LANG", "TERM", "SHELL", "USER", "TMPDIR"] as const;

/**
 * The platform-safe baseline environment for spawned children. win32:
 * guarantees SystemRoot, windir, COMSPEC, PATH, PATHEXT, USERPROFILE,
 * HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles(+x86),
 * TEMP/TMP, NUMBER_OF_PROCESSORS from the base env (inherited key spellings
 * preserved). POSIX: PATH, HOME, LANG, LC_*, TERM, SHELL, USER, TMPDIR.
 */
export function defaultChildEnv(
  platform: NodeJS.Platform = hostPlatform(),
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  const copy = (name: string): void => {
    const key = findEnvKey(base, name, platform);
    if (key === undefined || Object.hasOwn(result, key)) return;
    const value = base[key];
    if (typeof value === "string") result[key] = value;
  };
  if (platform === "win32") {
    for (const name of WIN32_CHILD_ENV_NAMES) copy(name);
    return result;
  }
  for (const name of POSIX_CHILD_ENV_NAMES) copy(name);
  for (const key of Object.keys(base)) {
    if (!key.startsWith("LC_")) continue;
    const value = base[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/**
 * defaultChildEnv merged with overrides using platform key semantics: on
 * win32 an override "path" replaces the inherited "Path" entry (never adds a
 * second key); an undefined override deletes the matching key. POSIX: exact
 * keys. Fixes stdio children spawned with a verbatim config env losing
 * SystemRoot/PATH on Windows.
 */
export function childEnv(
  overrides: Record<string, string | undefined>,
  platform: NodeJS.Platform = hostPlatform(),
): Record<string, string> {
  const result: Record<string, string> = defaultChildEnv(platform);
  for (const [name, value] of Object.entries(overrides)) {
    const key = findEnvKey(result, name, platform);
    if (value === undefined) {
      if (key !== undefined) delete result[key];
      continue;
    }
    result[key ?? name] = value;
  }
  return result;
}

const SANDBOX_ENV_ALLOWLIST_BASE = [
  "CI",
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "WINDIR",
  // Cowork runtime pointers (not secrets). The presentations/artifact helpers
  // resolve the managed @oai/artifact-tool package via these:
  // NODE_OPTIONS carries the `--import=<resolver>` hook and the two COWORK_* vars
  // point at the managed node_modules / ESM resolver. They are NOT baked into the
  // shell prelude, so they must survive the allowlist or sandboxed helper commands
  // fail to find the runtime.
  "COWORK_RUNTIME_DIR",
  "COWORK_RUNTIME_VERSION",
  "COWORK_RUNTIME_ASSET",
  "COWORK_RUNTIME_BIN",
  "COWORK_RUNTIME_NODE",
  "COWORK_RUNTIME_PYTHON",
  "COWORK_RUNTIME_GIT",
  "COWORK_RUNTIME_NODE_MODULES",
  "COWORK_RUNTIME_NODE_RESOLVER",
  "COWORK_RUNTIME_POPPLER_BIN",
  "COWORK_RUNTIME_SOFFICE",
  "COWORK_RUNTIME_LIBREOFFICE_DIR",
  "COWORK_RUNTIME_LIBREOFFICE_BINARY",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONDONTWRITEBYTECODE",
  "SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION",
] as const;

const SANDBOX_ENV_ALLOWLIST_WIN32_EXTRA = [
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "PYTHONUTF8",
  "PYTHONIOENCODING",
] as const;

const sandboxAllowlistPosix: ReadonlySet<string> = new Set<string>(SANDBOX_ENV_ALLOWLIST_BASE);
const sandboxAllowlistWin32: ReadonlySet<string> = new Set<string>([
  ...SANDBOX_ENV_ALLOWLIST_BASE,
  ...SANDBOX_ENV_ALLOWLIST_WIN32_EXTRA,
]);

/**
 * Env-var names allowed through to sandboxed commands. All platforms share
 * one base list; win32 additionally keeps the profile/config vars
 * (USERPROFILE, HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA, ProgramData,
 * ProgramFiles(+x86)) plus PYTHONUTF8/PYTHONIOENCODING, so sandboxed
 * git/gh/npm/pip can still find credentials, config, and caches on Windows.
 */
export function sandboxEnvAllowlist(
  platform: NodeJS.Platform = hostPlatform(),
): ReadonlySet<string> {
  return platform === "win32" ? sandboxAllowlistWin32 : sandboxAllowlistPosix;
}

/**
 * Build the minimal env for a sandboxed child from the allowlist. Environment
 * keys are case-insensitive on Windows, but Node preserves the spelling it
 * inherited (normally "Path", not "PATH") — the inherited spelling is
 * preserved so passing an explicit child env never drops the Windows search
 * path. POSIX matches allowlist names by exact key only.
 */
export function minimalSandboxEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = hostPlatform(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of sandboxEnvAllowlist(platform)) {
    const sourceKey = findEnvKey(source, name, platform);
    if (sourceKey === undefined || Object.hasOwn(env, sourceKey)) continue;
    const value = source[sourceKey];
    if (typeof value === "string") env[sourceKey] = value;
  }
  return env;
}
