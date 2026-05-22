import path from "node:path";

import { ensureManagedSofficeRuntimeReady } from "./ensureReady";

export function managedSofficeEnvValue(
  env: Record<string, string | undefined> | undefined,
  key: string,
): string {
  if (!env) return "";
  const actualKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actualKey ? (env[actualKey] ?? "") : "";
}

export function renderManagedSofficeRuntimeInstructions(
  env: Record<string, string | undefined> | undefined,
): string | null {
  const shimPath =
    managedSofficeEnvValue(env, "COWORK_SOFFICE") ||
    managedSofficeEnvValue(env, "COWORK_MANAGED_SOFFICE_SHIM");
  if (!shimPath) return null;
  const shimDir =
    managedSofficeEnvValue(env, "COWORK_MANAGED_SOFFICE_SHIM_DIR") || path.dirname(shimPath);
  const pathExample =
    process.platform === "win32"
      ? `$env:PATH = '${shimDir};' + $env:PATH`
      : `PATH=${shimDir}:$PATH`;
  return [
    "## Managed LibreOffice Runtime",
    "",
    `Cowork-managed LibreOffice is available through the \`soffice\` shim at \`${shimPath}\`.`,
    `When rendering documents, spreadsheets, or presentations, keep \`${shimDir}\` ahead of system paths, for example by prefixing shell commands with \`${pathExample}\`.`,
    "Do not conclude LibreOffice is unavailable from a broken Homebrew wrapper or a missing `/Applications/LibreOffice.app`; use the Cowork-managed shim.",
  ].join("\n");
}

export async function prepareManagedSofficeToolEnv(opts: {
  homedir?: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}): Promise<Record<string, string | undefined>> {
  const env = { ...(opts.env ?? process.env) };
  if (
    managedSofficeEnvValue(env, "COWORK_SOFFICE") ||
    managedSofficeEnvValue(env, "COWORK_MANAGED_SOFFICE_SHIM")
  ) {
    return env;
  }
  const setup = await ensureManagedSofficeRuntimeReady({
    homedir: opts.homedir,
    env,
    log: opts.log,
  });
  if (setup?.status === "available") {
    Object.assign(env, setup.runtimeEnv);
  }
  return env;
}
