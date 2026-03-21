import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

const WINDOWS_SOURCE_START_ATTEMPTS = 2;

export function getSourceStartupAttemptCount(
  useSource: boolean,
  platform: NodeJS.Platform = process.platform,
): number {
  return useSource && platform === "win32" ? WINDOWS_SOURCE_START_ATTEMPTS : 1;
}

export function getServerTerminationSignal(
  platform: NodeJS.Platform = process.platform,
): NodeJS.Signals | undefined {
  return platform === "win32" ? undefined : "SIGTERM";
}

export function buildSourceEnvForAttempt(
  baseEnv: NodeJS.ProcessEnv,
  attempt: number,
  platform: NodeJS.Platform = process.platform,
): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  if (platform !== "win32") {
    return { env: baseEnv, cleanup: () => {} };
  }

  const tempRoot = path.join(app.getPath("temp"), "cowork-bun-transpiler-cache");
  fs.mkdirSync(tempRoot, { recursive: true });
  const cacheDir = fs.mkdtempSync(path.join(tempRoot, "run-"));

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: cacheDir,
  };

  // If Bun crashes during startup, retry once with async transpilation disabled.
  if (attempt > 1) {
    env.BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER = "1";
  }

  return {
    env,
    cleanup: () => {
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup.
      }
    },
  };
}
