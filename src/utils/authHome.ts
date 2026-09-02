import path from "node:path";
import { home as resolveCoworkHomeDirectory } from "../platform/paths";
import type { AgentConfig } from "../types";

function homeFromSkillsDir(skillsDir: string): string | undefined {
  const trimmed = skillsDir.trim();
  if (!trimmed) return undefined;
  const normalized = path.normalize(trimmed);
  if (path.basename(normalized) !== "skills") return undefined;
  const coworkDir = path.dirname(normalized);
  if (path.basename(coworkDir) !== ".cowork") return undefined;
  return path.dirname(coworkDir);
}

export function resolveAuthHomeDir(
  config?: Pick<AgentConfig, "skillsDirs"> & Partial<Pick<AgentConfig, "userCoworkDir">>,
  fallbackHomedir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const userCoworkDir = config?.userCoworkDir?.trim();
  if (userCoworkDir && path.basename(path.normalize(userCoworkDir)) === ".cowork") {
    return path.dirname(path.normalize(userCoworkDir));
  }
  for (const skillsDir of config?.skillsDirs ?? []) {
    const derived = homeFromSkillsDir(skillsDir);
    if (derived) return derived;
  }
  const fromFallback = fallbackHomedir?.trim();
  if (fromFallback) return fromFallback;
  if (env.COWORK_HOME_OVERRIDE?.trim()) {
    return resolveCoworkHomeDirectory(env);
  }
  const fromEnv = env.HOME?.trim() || env.USERPROFILE?.trim();
  return fromEnv || resolveCoworkHomeDirectory(env);
}
