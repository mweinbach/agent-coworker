import fs from "node:fs/promises";
import path from "node:path";
import { getAiCoworkerPaths } from "../store/connections";
import { CODEX_RUNTIME_STATE_FILE, CODEX_RUNTIME_STATE_VERSION } from "./constants";
import type { CodexPrimaryRuntimeSkillResult, CodexPrimaryRuntimeState } from "./types";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function runtimeStateFile(homedir?: string): string {
  const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
  return path.join(paths.configDir, CODEX_RUNTIME_STATE_FILE);
}

export async function writeState(opts: {
  stateFile: string;
  artifactSource?: string;
  skills: CodexPrimaryRuntimeSkillResult[];
}): Promise<void> {
  const state: CodexPrimaryRuntimeState = {
    version: CODEX_RUNTIME_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    ...(opts.artifactSource ? { artifactSource: opts.artifactSource } : {}),
    installedSkills: opts.skills
      .filter((skill) => skill.status === "installed" || skill.status === "already_installed")
      .map((skill) => skill.name),
  };
  await fs.mkdir(path.dirname(opts.stateFile), { recursive: true });
  await fs.writeFile(opts.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}
