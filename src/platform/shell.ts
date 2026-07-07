import path from "node:path";

import { hostPlatform } from "./host";

export type PlatformShellExecutionStep = { file: string; args: string[] };

/**
 * The command dialect the bash tool's shell actually parses on a platform:
 * PowerShell on Windows (pwsh/powershell.exe), POSIX sh elsewhere.
 * This is the ONE platform fact the model is told about command execution;
 * everything else (binary selection, quoting transport, PATH prelude) is
 * owned by this module and invisible to the model.
 */
export type ShellDialect = "posix" | "powershell";

export function shellDialect(platform: NodeJS.Platform = hostPlatform()): ShellDialect {
  return platform === "win32" ? "powershell" : "posix";
}

/**
 * PowerShell's lexer treats the Unicode smart-quote family (U+2018–U+201B) as
 * single-quote delimiters, so they must be escaped (by doubling, like ASCII
 * `'`) or they terminate the string and inject.
 */
const POWERSHELL_QUOTE_FAMILY = /['‘’‚‛]/g;

/**
 * Quote a value for safe embedding in a command of the given dialect.
 * posix: single-quote wrap with `'\''` escaping. powershell: single-quote wrap
 * doubling every character PowerShell's lexer accepts as a single quote
 * (ASCII and smart variants).
 */
export function quoteShellValue(value: string, dialect: ShellDialect): string {
  if (dialect === "powershell") {
    return `'${value.replace(POWERSHELL_QUOTE_FAMILY, (q) => q + q)}'`;
  }
  return quotePosixShellValue(value);
}

export function quotePosixShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function quotePowerShellSingleQuotedValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pathImplForPlatform(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function dedupePathDirs(pathDirs: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of pathDirs) {
    if (!dir) continue;
    const key = platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

export function buildPlatformShellExecutionPlan(
  platform: NodeJS.Platform,
  command: string,
  opts: { userShell?: string } = {},
): PlatformShellExecutionStep[] {
  if (platform === "win32") {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ];
    return [
      { file: "pwsh", args },
      { file: "powershell.exe", args },
    ];
  }

  const userShell = opts.userShell ?? process.env.SHELL?.trim();
  const plan: PlatformShellExecutionStep[] = [];

  if (userShell) {
    plan.push({ file: userShell, args: ["-lc", command] });
  }

  plan.push(
    { file: "/bin/bash", args: ["-lc", command] },
    { file: "/bin/sh", args: ["-lc", command] },
    { file: "bash", args: ["-lc", command] },
    { file: "sh", args: ["-lc", command] },
  );

  return plan;
}

export function buildPlatformShellCommandWithRuntimePrelude(opts: {
  command: string;
  platform: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}): string {
  let command = opts.command;
  const env = opts.env || process.env;
  const pathImpl = pathImplForPlatform(opts.platform);
  const runtimeBin = envValue(env, "COWORK_RUNTIME_BIN");
  const runtimePython = envValue(env, "COWORK_RUNTIME_PYTHON");
  const runtimeNode = envValue(env, "COWORK_RUNTIME_NODE");
  const runtimeGit = envValue(env, "COWORK_RUNTIME_GIT");
  const runtimePopplerBin = envValue(env, "COWORK_RUNTIME_POPPLER_BIN");

  const pathDirs: string[] = [];
  if (runtimeBin) {
    pathDirs.push(runtimeBin);
  }
  if (runtimeNode) {
    pathDirs.push(pathImpl.dirname(runtimeNode));
  }
  if (runtimePython) {
    const pythonDir = pathImpl.dirname(runtimePython);
    pathDirs.push(pythonDir);
    if (opts.platform === "win32") {
      pathDirs.push(pathImpl.join(pythonDir, "Scripts"));
    }
  }
  if (runtimeGit) {
    pathDirs.push(pathImpl.dirname(runtimeGit));
  }
  if (runtimePopplerBin) {
    pathDirs.push(runtimePopplerBin);
  }

  const uniquePathDirs = dedupePathDirs(pathDirs, opts.platform);
  if (uniquePathDirs.length === 0) {
    return command;
  }

  if (opts.platform === "win32") {
    const statements: string[] = [];
    if (uniquePathDirs.length > 0) {
      statements.push(
        `$env:PATH = ${quotePowerShellSingleQuotedValue(uniquePathDirs.join(";"))} + ';' + $env:PATH`,
      );
    }
    command = `${statements.join("; ")}; ${command}`;
  } else {
    const statements: string[] = [];
    if (uniquePathDirs.length > 0) {
      statements.push(`export PATH=${quotePosixShellValue(uniquePathDirs.join(":"))}:$PATH`);
    }
    command = `${statements.join(" && ")} && ${command}`;
  }

  return command;
}
