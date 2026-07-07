import os from "node:os";
import path from "node:path";

import { hostPlatform } from "./host";
import { pathImplForPlatform } from "./pathImpl";

export type PlatformShellExecutionStep = {
  file: string;
  args: string[];
  /** The original model-authored script, for logs/UI — `args` may carry an
   * opaque -EncodedCommand payload instead of readable text. */
  displayCommand?: string;
  /** When present, the executor must write `content` to `path` (plain byte
   * write; a UTF-8 BOM is already embedded) before spawning any step of the
   * plan and delete it afterwards. All steps of one plan share one script. */
  tempScript?: { path: string; content: string };
};

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

/**
 * UTF-8 output pin for both pwsh 7 and Windows PowerShell 5.1, so child
 * output decodes identically to POSIX platforms. [Console]::OutputEncoding
 * can throw in consoleless hosts, hence the try/catch. PYTHONUTF8 makes
 * Python child processes emit UTF-8 regardless of the ANSI code page.
 * Exported for tests. Empty on POSIX (UTF-8 is ambient there).
 */
export function encodingPrelude(platform: NodeJS.Platform = hostPlatform()): string {
  if (platform !== "win32") return "";
  return [
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "$env:PYTHONUTF8 = '1'",
  ].join("; ");
}

/**
 * Exit-code contract (pinned; matches GitHub Actions' PowerShell wrapper):
 * if any native command ran, the shell exits with the LAST native command's
 * exit code — even when a cmdlet ran afterwards. Cmdlet-only scripts exit 0,
 * or 1 when PowerShell itself reports a terminating error. 5.1-safe (no `??`).
 */
const POWERSHELL_EXIT_CODE_GUARD =
  "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }";

/**
 * CreateProcess caps the command line at 32,767 UTF-16 units. -EncodedCommand
 * is base64(UTF-16LE) ≈ 2.67x the script's char count, so scripts beyond this
 * threshold switch to a temp-file `-File` transport instead of failing with a
 * brand-new "command line too long" error class.
 */
const WIN32_ENCODED_COMMAND_LIMIT = 30000;

/** Shells whose `-lc <command>` contract is sh-compatible. fish/nushell/pwsh
 * as $SHELL parse POSIX commands differently (or not at all), and their
 * non-ENOENT failures would mask the /bin/bash fallback — skip them. */
const SH_COMPATIBLE_BASENAMES = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

function isShCompatibleUserShell(userShell: string): boolean {
  const base = userShell.split(/[\\/]/).pop() ?? "";
  return SH_COMPATIBLE_BASENAMES.has(base);
}

/**
 * Build the per-platform shell invocation for a model-authored command.
 *
 * The transport guarantee on every platform: the command string crosses
 * EXACTLY ONE shell interpretation layer.
 * - POSIX: single argv element to `bash -lc` (or an sh-compatible $SHELL).
 * - win32: `pwsh -EncodedCommand base64(utf16le(script))` — no PowerShell CLI
 *   re-parse, so embedded quotes/backticks/$ survive byte-exact (the
 *   `git commit -m "..."` corruption class). Scripts too large for the
 *   CreateProcess command-line ceiling ship as a `-File` temp script instead;
 *   the executor materializes `tempScript` before spawn and removes it after.
 *   The script is wrapped with a UTF-8 encoding prelude and the pinned
 *   exit-code guard (see POWERSHELL_EXIT_CODE_GUARD).
 */
export function buildPlatformShellExecutionPlan(
  platform: NodeJS.Platform,
  command: string,
  opts: { userShell?: string; tempDir?: string; scriptId?: string } = {},
): PlatformShellExecutionStep[] {
  if (platform === "win32") {
    const script = `${encodingPrelude(platform)}\n${command}\n${POWERSHELL_EXIT_CODE_GUARD}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const baseArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

    if (encoded.length <= WIN32_ENCODED_COMMAND_LIMIT) {
      const args = [...baseArgs, "-EncodedCommand", encoded];
      return [
        { file: "pwsh", args, displayCommand: command },
        { file: "powershell.exe", args, displayCommand: command },
      ];
    }

    // Oversized: -File temp script. UTF-8 BOM is embedded in the content so a
    // plain byte write is correct on both pwsh 7 (UTF-8 default) and
    // Windows PowerShell 5.1 (ANSI default without a BOM).
    const scriptId = opts.scriptId ?? crypto.randomUUID();
    const tempDir = opts.tempDir ?? os.tmpdir();
    const scriptPath = path.win32.join(tempDir, `cowork-shell-${scriptId}.ps1`);
    const tempScript = { path: scriptPath, content: `\ufeff${script}` };
    const args = [...baseArgs, "-File", scriptPath];
    return [
      { file: "pwsh", args, displayCommand: command, tempScript },
      { file: "powershell.exe", args, displayCommand: command, tempScript },
    ];
  }

  const userShell = (opts.userShell ?? process.env.SHELL?.trim()) || undefined;
  const plan: PlatformShellExecutionStep[] = [];

  if (userShell && isShCompatibleUserShell(userShell)) {
    plan.push({ file: userShell, args: ["-lc", command], displayCommand: command });
  }

  plan.push(
    { file: "/bin/bash", args: ["-lc", command], displayCommand: command },
    { file: "/bin/sh", args: ["-lc", command], displayCommand: command },
    { file: "bash", args: ["-lc", command], displayCommand: command },
    { file: "sh", args: ["-lc", command], displayCommand: command },
  );

  return plan;
}

/**
 * The canonical Python invocation for a platform+environment: the managed
 * runtime's absolute interpreter when COWORK_RUNTIME_PYTHON is set, otherwise
 * bare `python` (win32; the runtime PATH prelude guarantees it when the
 * managed runtime is active) or `python3` (POSIX). NEVER `py -3` — the py
 * launcher resolves via the Windows registry and bypasses the runtime PATH
 * prelude, which is how Windows sessions ended up on system Python with
 * missing packages while macOS/Linux sessions worked.
 */
export function pythonInvocation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = hostPlatform(),
): { command: string; display: string } {
  const runtimePython = envValue(env, "COWORK_RUNTIME_PYTHON");
  if (runtimePython) return { command: runtimePython, display: runtimePython };
  const bare = platform === "win32" ? "python" : "python3";
  return { command: bare, display: bare };
}

/**
 * The ONE platform fact the model is told about command execution: which
 * dialect the bash tool's shell parses on THIS host. Rendered into the system
 * prompt's Shell Execution Policy section AND the bash tool description —
 * never hand-written prose. A macOS session never carries Windows rules and
 * vice versa. Codex executes through its own shell, so `executor: "codex"`
 * renders nothing (its runtime owns the equivalent guidance).
 */
export function promptGuidance(
  opts: {
    platform?: NodeJS.Platform;
    executor?: "cowork" | "codex" | "external";
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  if (opts.executor === "codex") return "";
  const platform = opts.platform ?? hostPlatform();
  const python = pythonInvocation(opts.env ?? process.env, platform);
  if (shellDialect(platform) === "powershell") {
    return [
      "The `bash` tool executes PowerShell on this machine (`pwsh`, falling back to `powershell.exe`).",
      '- Write PowerShell syntax: chain with `;`, set env vars with `$env:NAME = "value"`, list files with `Get-ChildItem -Force`.',
      "- Do not use POSIX-only constructs: `export`, `source`, heredocs, or `&&`/`||` chaining (unavailable on the `powershell.exe` fallback).",
      `- Run Python as \`${python.display}\` (never \`py -3\`; it bypasses the managed runtime).`,
    ].join("\n");
  }
  return [
    "The `bash` tool executes bash on this machine (login shell, `sh` fallback).",
    "- Standard POSIX syntax applies: `&&` chaining, `export NAME=value`, `ls -la`.",
    `- Run Python as \`${python.display}\`.`,
  ].join("\n");
}

/**
 * Canned cross-platform commands for harness prompts and evals — the command
 * strings a model would be expected to produce on the given platform. Absorbs
 * packages/harness/src/platformCommands.ts (which now re-exports this).
 */
export interface PlatformCommands {
  runPythonScript(scriptPath: string): string;
  printWorkingDirectory(): string;
  listDirectory(dirPath?: string): string;
  countLines(filePath: string): string;
}

export function commands(
  platform: NodeJS.Platform = hostPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): PlatformCommands {
  const dialect = shellDialect(platform);
  const python = pythonInvocation(env, platform);
  const q = (value: string) => quoteShellValue(value, dialect);
  if (dialect === "powershell") {
    // A quoted executable path needs PowerShell's call operator.
    const invoke = /[\s'‘’‚‛]/.test(python.command) ? `& ${q(python.command)}` : python.command;
    return {
      runPythonScript: (scriptPath) => `${invoke} ${q(scriptPath)}`,
      printWorkingDirectory: () => "(Get-Location).Path",
      listDirectory: (dirPath) =>
        dirPath ? `Get-ChildItem -Force ${q(dirPath)}` : "Get-ChildItem -Force",
      countLines: (filePath) => `(Get-Content ${q(filePath)} | Measure-Object -Line).Lines`,
    };
  }
  return {
    runPythonScript: (scriptPath) => `${q(python.command)} ${q(scriptPath)}`,
    printWorkingDirectory: () => "pwd",
    listDirectory: (dirPath) => (dirPath ? `ls -la ${q(dirPath)}` : "ls -la"),
    countLines: (filePath) => `wc -l ${q(filePath)}`,
  };
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
