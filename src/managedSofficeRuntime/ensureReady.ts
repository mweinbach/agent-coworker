import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { helperSource } from "./helperSource";
import { isTruthy, managedSofficeRoot, prependPath } from "./paths";
import { writePosixShim, writeWindowsShim } from "./shims";
import type { EnsureManagedSofficeRuntimeOptions, ManagedSofficeRuntimeSetupResult } from "./types";

export async function ensureManagedSofficeRuntimeReady(
  opts: EnsureManagedSofficeRuntimeOptions = {},
): Promise<ManagedSofficeRuntimeSetupResult | null> {
  const env = opts.env ?? process.env;
  if (isTruthy(env.COWORK_DISABLE_MANAGED_SOFFICE)) {
    return {
      status: "disabled",
      runtimeEnv: {},
      reason: "COWORK_DISABLE_MANAGED_SOFFICE is enabled.",
    };
  }

  const home = path.resolve(opts.homedir ?? os.homedir());
  const rootDir = managedSofficeRoot(home);
  const shimDir = path.join(rootDir, "bin");
  const helperPath = path.join(rootDir, "libexec", "managed-soffice.mjs");
  const shimPath = path.join(shimDir, process.platform === "win32" ? "soffice.cmd" : "soffice");
  const nodePath = opts.nodePath || env.COWORK_CODEX_RUNTIME_NODE || process.execPath;

  await fs.mkdir(path.dirname(helperPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(shimDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(helperPath, helperSource(), { encoding: "utf-8", mode: 0o755 });
  await fs.chmod(helperPath, 0o755);
  if (process.platform === "win32") {
    await writeWindowsShim(shimPath, nodePath, helperPath);
  } else {
    await writePosixShim(shimPath, nodePath, helperPath);
  }

  const baseRuntimeEnv: Record<string, string> = {
    COWORK_MANAGED_SOFFICE_ROOT: rootDir,
    COWORK_MANAGED_SOFFICE_SHIM_DIR: shimDir,
    COWORK_MANAGED_SOFFICE_SHIM: shimPath,
    COWORK_SOFFICE: shimPath,
  };
  const runtimeEnv = prependPath(env, baseRuntimeEnv, shimDir);

  return {
    status: "available",
    runtimeEnv,
    rootDir,
    shimDir,
    shimPath,
    helperPath,
  };
}
