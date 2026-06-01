import fs from "node:fs/promises";
import path from "node:path";
import { getAiCoworkerPaths } from "../store/connections";
import { ARTIFACT_RUNTIME_STATE_FILE, ARTIFACT_RUNTIME_STATE_VERSION } from "./constants";
import type { ArtifactRuntimeState } from "./types";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function artifactRuntimeStateFile(homedir?: string): string {
  const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
  return path.join(paths.configDir, ARTIFACT_RUNTIME_STATE_FILE);
}

export async function writeState(opts: {
  stateFile: string;
  runtimeSource?: string;
  artifactSource?: string;
  migratedFrom?: string;
}): Promise<void> {
  const state: ArtifactRuntimeState = {
    version: ARTIFACT_RUNTIME_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    ...(opts.runtimeSource ? { runtimeSource: opts.runtimeSource } : {}),
    ...(opts.artifactSource ? { artifactSource: opts.artifactSource } : {}),
    ...(opts.migratedFrom ? { migratedFrom: opts.migratedFrom } : {}),
  };
  await fs.mkdir(path.dirname(opts.stateFile), { recursive: true });
  await fs.writeFile(opts.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}
