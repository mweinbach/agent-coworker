import path from "node:path";
import type { AgentConfig } from "../types";

type FeatureGatedSkillTarget = {
  name: string;
  rootDir: string;
};

/**
 * Built-in skills that back gated product features. These are agent-facing
 * infrastructure rather than user-managed skills:
 *
 * - They are only discoverable (prompt, `skill` tool, slash commands) while the
 *   owning feature is enabled.
 * - They are never listed in the skill/plugin management catalog, so users
 *   cannot disable a backend service the feature depends on.
 *
 * Gating applies only to the bundled copies under `{builtInDir}/skills`; a
 * user- or project-installed skill that happens to share a name is unaffected.
 */
const FEATURE_GATED_BUILTIN_SKILLS: Record<string, (config: AgentConfig) => boolean> = {
  task: (config) => config.tasksEnabled === true,
  memories: (config) => config.advancedMemory === true,
};

function isBuiltInSkillRoot(config: AgentConfig, rootDir: string): boolean {
  const builtInSkillsDir = path.resolve(config.builtInDir, "skills");
  const resolvedRoot = path.resolve(rootDir);
  return resolvedRoot === builtInSkillsDir || resolvedRoot.startsWith(builtInSkillsDir + path.sep);
}

function featureGateFor(
  config: AgentConfig,
  skill: FeatureGatedSkillTarget,
): ((config: AgentConfig) => boolean) | null {
  const gate = FEATURE_GATED_BUILTIN_SKILLS[skill.name];
  if (!gate) return null;
  if (!isBuiltInSkillRoot(config, skill.rootDir)) return null;
  return gate;
}

/**
 * Whether a scanned skill installation may be discovered for agent use
 * (system prompt, `skill` tool, slash commands). Feature-gated built-in skills
 * are discoverable only while their feature is enabled.
 */
export function isSkillDiscoveryAllowed(
  config: AgentConfig,
  skill: FeatureGatedSkillTarget,
): boolean {
  const gate = featureGateFor(config, skill);
  return gate ? gate(config) : true;
}

/**
 * Whether a scanned skill installation may appear in the user-facing skill
 * management catalog. Feature-gated built-in skills are always hidden there —
 * even while enabled — because they are backend services owned by the feature,
 * not user-toggleable skills.
 */
export function isSkillVisibleInCatalog(
  config: AgentConfig,
  skill: FeatureGatedSkillTarget,
): boolean {
  return featureGateFor(config, skill) === null;
}
