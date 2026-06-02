import path from "node:path";

export type PlatformShellExecutionStep = { file: string; args: string[] };

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
  const runtimePython = env.COWORK_ARTIFACT_RUNTIME_PYTHON;
  const runtimeNode = env.COWORK_ARTIFACT_RUNTIME_NODE;
  const managedSofficeShim = env.COWORK_SOFFICE || env.COWORK_MANAGED_SOFFICE_SHIM;
  const managedSofficeShimDir =
    env.COWORK_MANAGED_SOFFICE_SHIM_DIR ||
    (managedSofficeShim ? pathImpl.dirname(managedSofficeShim) : undefined);

  const pathDirs: string[] = [];
  if (managedSofficeShimDir) {
    pathDirs.push(managedSofficeShimDir);
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

  const uniquePathDirs = dedupePathDirs(pathDirs, opts.platform);
  const envExports: Record<string, string> = {};
  if (managedSofficeShim) {
    envExports.COWORK_SOFFICE = managedSofficeShim;
  }
  if (managedSofficeShimDir) {
    envExports.COWORK_MANAGED_SOFFICE_SHIM_DIR = managedSofficeShimDir;
  }

  if (uniquePathDirs.length === 0 && Object.keys(envExports).length === 0) {
    return command;
  }

  if (opts.platform === "win32") {
    const statements: string[] = [];
    if (uniquePathDirs.length > 0) {
      statements.push(
        `$env:PATH = ${quotePowerShellSingleQuotedValue(uniquePathDirs.join(";"))} + ';' + $env:PATH`,
      );
    }
    for (const [key, value] of Object.entries(envExports)) {
      statements.push(`$env:${key} = ${quotePowerShellSingleQuotedValue(value)}`);
    }
    command = `${statements.join("; ")}; ${command}`;
  } else {
    const statements: string[] = [];
    if (uniquePathDirs.length > 0) {
      statements.push(`export PATH=${quotePosixShellValue(uniquePathDirs.join(":"))}:$PATH`);
    }
    for (const [key, value] of Object.entries(envExports)) {
      statements.push(`export ${key}=${quotePosixShellValue(value)}`);
    }
    command = `${statements.join(" && ")} && ${command}`;
  }

  return command;
}
