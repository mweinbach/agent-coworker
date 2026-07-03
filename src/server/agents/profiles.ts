import fs from "node:fs/promises";
import path from "node:path";

import {
  type AgentProfileCatalogEntry,
  type AgentProfileCopyInput,
  type AgentProfileDefinition,
  type AgentProfileDiagnostic,
  type AgentProfileScope,
  type AgentProfileSnapshot,
  type AgentProfilesCatalog,
  type AgentProfileUpsertInput,
  type AgentProfileWorkspaceOverrides,
  agentProfileCopyInputSchema,
  agentProfileIdSchema,
  agentProfileScopeSchema,
  agentProfileUpsertInputSchema,
  agentProfileWorkspaceOverridesSchema,
  buildAgentProfileRef,
  createAgentProfileSnapshot,
  normalizeAgentProfileDefinition,
  parseAgentProfileRef,
} from "../../shared/agentProfiles";
import type { AgentRole } from "../../shared/agents";
import type { AgentConfig } from "../../types";
import { AGENT_ROLE_DEFINITIONS } from "./roles";

const PROFILE_DIR_NAME = "agent-profiles";
const WORKSPACE_OVERRIDES_FILE_NAME = "workspace-overrides.json";
const WORKSPACE_OVERRIDES_PROFILE_ID = "workspace-overrides";
const MAIN_AGENT_PROFILE_ID = "default";

const BUILT_IN_PROFILE_DISPLAY_NAMES: Record<AgentRole, string> = {
  default: "Main Agent",
  explorer: "Explorer",
  research: "Research",
  worker: "Worker",
  reviewer: "Reviewer",
};

const BUILT_IN_PROFILE_DESCRIPTIONS: Partial<Record<AgentRole, string>> = {
  default: "Direct clone of the parent agent for bounded collaborative work.",
};

type ReadScopeResult = {
  entries: AgentProfileCatalogEntry[];
  diagnostics: AgentProfileDiagnostic[];
};

export function getAgentProfileDir(config: AgentConfig, scope: AgentProfileScope): string {
  return path.join(
    scope === "workspace" ? config.projectCoworkDir : config.userCoworkDir,
    PROFILE_DIR_NAME,
  );
}

function profilePathForId(config: AgentConfig, scope: AgentProfileScope, id: string): string {
  return path.join(getAgentProfileDir(config, scope), `${id}.json`);
}

async function readScope(config: AgentConfig, scope: AgentProfileScope): Promise<ReadScopeResult> {
  const dir = getAgentProfileDir(config, scope);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { entries: [], diagnostics: [] };
    }
    return {
      entries: [],
      diagnostics: [
        {
          scope,
          path: dir,
          severity: "error",
          message: `Unable to read profile directory: ${formatError(error)}`,
        },
      ],
    };
  }

  const entries: AgentProfileCatalogEntry[] = [];
  const diagnostics: AgentProfileDiagnostic[] = [];
  for (const file of files.sort((left, right) => left.localeCompare(right))) {
    if (!file.endsWith(".json") || file === WORKSPACE_OVERRIDES_FILE_NAME) continue;
    const filePath = path.join(dir, file);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = applyAgentProfileInvariants(
        await applyAgentProfilePromptDefaults(
          config,
          normalizeAgentProfileDefinition(JSON.parse(raw)),
        ),
      );
      entries.push({
        scope,
        path: filePath,
        locked: isLockedProfile(parsed.id),
        effective: false,
        shadowed: false,
        profile: parsed,
      });
    } catch (error) {
      diagnostics.push({
        scope,
        path: filePath,
        severity: "error",
        message: `Invalid agent profile: ${formatError(error)}`,
      });
    }
  }
  return { entries, diagnostics };
}

export async function readAgentProfilesCatalog(config: AgentConfig): Promise<AgentProfilesCatalog> {
  const [globalProfiles, workspaceProfiles, workspaceOverrides] = await Promise.all([
    readScope(config, "global"),
    readScope(config, "workspace"),
    readWorkspaceOverrides(config),
  ]);

  const workspaceIds = new Set(workspaceProfiles.entries.map((entry) => entry.profile.id));
  const globalIds = new Set(globalProfiles.entries.map((entry) => entry.profile.id));
  const disabledGlobalIds = new Set(
    workspaceOverrides.overrides.disabledGlobalProfileIds.filter((id) => !isLockedProfile(id)),
  );
  const builtInProfiles = await buildBuiltInProfileEntries(config, globalIds);
  const profiles = [
    ...workspaceProfiles.entries,
    ...globalProfiles.entries,
    ...builtInProfiles,
  ].map((entry) => {
    const shadowed = entry.scope === "global" && workspaceIds.has(entry.profile.id);
    const workspaceDisabled = entry.scope === "global" && disabledGlobalIds.has(entry.profile.id);
    return {
      ...entry,
      shadowed,
      workspaceDisabled,
      effective: entry.scope === "workspace" || (!shadowed && !workspaceDisabled),
    };
  });

  const effectiveProfiles = profiles.filter((entry) => entry.effective && entry.profile.enabled);
  return {
    profiles,
    effectiveProfiles,
    diagnostics: [
      ...workspaceProfiles.diagnostics,
      ...globalProfiles.diagnostics,
      ...workspaceOverrides.diagnostics,
    ],
    roots: {
      globalDir: getAgentProfileDir(config, "global"),
      workspaceDir: getAgentProfileDir(config, "workspace"),
    },
  };
}

function workspaceOverridesPath(config: AgentConfig): string {
  return path.join(getAgentProfileDir(config, "workspace"), WORKSPACE_OVERRIDES_FILE_NAME);
}

async function readWorkspaceOverrides(config: AgentConfig): Promise<{
  overrides: AgentProfileWorkspaceOverrides;
  diagnostics: AgentProfileDiagnostic[];
}> {
  const filePath = workspaceOverridesPath(config);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { overrides: { version: 1, disabledGlobalProfileIds: [] }, diagnostics: [] };
    }
    return {
      overrides: { version: 1, disabledGlobalProfileIds: [] },
      diagnostics: [
        {
          scope: "workspace",
          path: filePath,
          severity: "error",
          message: `Unable to read workspace subagent overrides: ${formatError(error)}`,
        },
      ],
    };
  }
  try {
    return {
      overrides: agentProfileWorkspaceOverridesSchema.parse(JSON.parse(raw)),
      diagnostics: [],
    };
  } catch (error) {
    return {
      overrides: { version: 1, disabledGlobalProfileIds: [] },
      diagnostics: [
        {
          scope: "workspace",
          path: filePath,
          severity: "error",
          message: `Invalid workspace subagent overrides: ${formatError(error)}`,
        },
      ],
    };
  }
}

export async function setAgentProfileWorkspaceAvailability(
  config: AgentConfig,
  idRaw: string,
  disabled: boolean,
): Promise<AgentProfilesCatalog> {
  const id = agentProfileIdSchema.parse(idRaw);
  if (isLockedProfile(id)) {
    throw new Error("The main agent profile is always available and cannot be disabled.");
  }
  const catalog = await readAgentProfilesCatalog(config);
  const globalEntry = catalog.profiles.find(
    (entry) => entry.scope === "global" && entry.profile.id === id,
  );
  if (!globalEntry) {
    throw new Error(`Unknown global subagent profile: ${id}`);
  }
  const { overrides } = await readWorkspaceOverrides(config);
  const disabledIds = new Set(overrides.disabledGlobalProfileIds);
  if (disabled) {
    disabledIds.add(id);
  } else {
    disabledIds.delete(id);
  }
  const next: AgentProfileWorkspaceOverrides = {
    version: 1,
    disabledGlobalProfileIds: [...disabledIds].sort((left, right) => left.localeCompare(right)),
  };
  const filePath = workspaceOverridesPath(config);
  if (next.disabledGlobalProfileIds.length === 0) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  } else {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  }
  return await readAgentProfilesCatalog(config);
}

export async function resolveAgentProfileSnapshot(
  config: AgentConfig,
  profileRefRaw: string,
): Promise<AgentProfileSnapshot> {
  const catalog = await readAgentProfilesCatalog(config);
  const match = findAgentProfileEntry(catalog, profileRefRaw);
  if (!match) {
    throw new Error(`Unknown subagent profile: ${profileRefRaw}`);
  }
  if (!match.profile.enabled) {
    throw new Error(`Subagent profile is disabled: ${match.scope}:${match.profile.id}`);
  }
  if (match.workspaceDisabled) {
    throw new Error(
      `Subagent profile is disabled in this workspace: ${match.scope}:${match.profile.id}`,
    );
  }
  return createAgentProfileSnapshot(match.scope, match.profile);
}

export async function upsertAgentProfile(
  config: AgentConfig,
  input: AgentProfileUpsertInput,
): Promise<AgentProfilesCatalog> {
  const parsed = agentProfileUpsertInputSchema.parse(input);
  const { scope, ...profile } = parsed;
  await writeProfileFile(config, scope, profile);
  return await readAgentProfilesCatalog(config);
}

export async function deleteAgentProfile(
  config: AgentConfig,
  scopeRaw: string,
  idRaw: string,
): Promise<AgentProfilesCatalog> {
  const scope = agentProfileScopeSchema.parse(scopeRaw);
  const id = agentProfileIdSchema.parse(idRaw);
  assertWritableProfileId(id);
  const filePath = profilePathForId(config, scope, id);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  return await readAgentProfilesCatalog(config);
}

export async function copyAgentProfile(
  config: AgentConfig,
  input: AgentProfileCopyInput,
): Promise<AgentProfilesCatalog> {
  const parsed = agentProfileCopyInputSchema.parse(input);
  const catalog = await readAgentProfilesCatalog(config);
  const source = findAgentProfileEntry(catalog, parsed.sourceRef);
  if (!source) {
    throw new Error(`Unknown subagent profile: ${parsed.sourceRef}`);
  }
  const profile = source.profile;
  const targetProfile: AgentProfileDefinition = {
    version: 1,
    id: parsed.targetId ?? profile.id,
    displayName: parsed.targetDisplayName ?? profile.displayName,
    description: profile.description,
    enabled: true,
    baseRole: profile.baseRole,
    prompt: profile.prompt,
    allowedBuiltInTools: profile.allowedBuiltInTools,
    allowedMcpServers: profile.allowedMcpServers,
    skillNames: profile.skillNames,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.defaultTaskType ? { defaultTaskType: profile.defaultTaskType } : {}),
    ...(profile.defaultContextMode ? { defaultContextMode: profile.defaultContextMode } : {}),
  };
  await writeProfileFile(config, parsed.targetScope, targetProfile);
  return await readAgentProfilesCatalog(config);
}

function findAgentProfileEntry(
  catalog: AgentProfilesCatalog,
  profileRefRaw: string,
): AgentProfileCatalogEntry | null {
  const ref = parseAgentProfileRef(profileRefRaw);
  if (ref.kind === "scoped") {
    return (
      catalog.profiles.find((entry) => entry.scope === ref.scope && entry.profile.id === ref.id) ??
      null
    );
  }
  const effective = catalog.profiles.find(
    (entry) => entry.effective && entry.profile.id === ref.id,
  );
  if (effective) return effective;
  // Fall back to non-effective matches so refs to workspace-disabled or
  // shadowed profiles fail with a precise reason instead of "unknown".
  return catalog.profiles.find((entry) => entry.profile.id === ref.id) ?? null;
}

async function writeProfileFile(
  config: AgentConfig,
  scope: AgentProfileScope,
  profile: AgentProfileDefinition,
): Promise<void> {
  const normalized = applyAgentProfileInvariants(normalizeAgentProfileDefinition(profile));
  assertWritableProfileId(normalized.id);
  const dir = getAgentProfileDir(config, scope);
  await fs.mkdir(dir, { recursive: true });
  const filePath = profilePathForId(config, scope, normalized.id);
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
}

function assertWritableProfileId(id: string): void {
  if (id === WORKSPACE_OVERRIDES_PROFILE_ID) {
    throw new Error(`Reserved subagent profile id: ${id}`);
  }
}

async function buildBuiltInProfileEntries(
  config: AgentConfig,
  globalOverrideIds: ReadonlySet<string>,
): Promise<AgentProfileCatalogEntry[]> {
  const roles = Object.values(AGENT_ROLE_DEFINITIONS).filter(
    (role) => !globalOverrideIds.has(role.id),
  );
  return await Promise.all(
    roles.map(async (role) => {
      const profile = normalizeAgentProfileDefinition({
        version: 1,
        id: role.id,
        displayName: BUILT_IN_PROFILE_DISPLAY_NAMES[role.id],
        description: BUILT_IN_PROFILE_DESCRIPTIONS[role.id] ?? role.description,
        enabled: true,
        baseRole: role.id,
        prompt: await readBuiltInRolePrompt(config, role.promptFile),
        allowedBuiltInTools: role.allowTools,
        allowedMcpServers: [],
        skillNames: [],
        ...(role.id === MAIN_AGENT_PROFILE_ID ? { defaultContextMode: "full" } : {}),
      });
      return {
        scope: "global",
        builtIn: true,
        locked: isLockedProfile(profile.id),
        effective: false,
        shadowed: false,
        profile,
      };
    }),
  );
}

async function readBuiltInRolePrompt(config: AgentConfig, promptFile: string): Promise<string> {
  const promptPath = path.join(config.builtInDir, "prompts", "sub-agents", promptFile);
  try {
    return (await fs.readFile(promptPath, "utf-8")).trim();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function applyAgentProfileInvariants(profile: AgentProfileDefinition): AgentProfileDefinition {
  if (!isLockedProfile(profile.id)) return profile;
  return {
    ...profile,
    enabled: true,
  };
}

function isLockedProfile(id: string): boolean {
  return id === MAIN_AGENT_PROFILE_ID;
}

async function applyAgentProfilePromptDefaults(
  config: AgentConfig,
  profile: AgentProfileDefinition,
): Promise<AgentProfileDefinition> {
  if (profile.prompt.trim()) return profile;
  const role = AGENT_ROLE_DEFINITIONS[profile.baseRole];
  const prompt = await readBuiltInRolePrompt(config, role.promptFile);
  if (!prompt) return profile;
  return {
    ...profile,
    prompt,
  };
}

export function formatAgentProfilePromptSummaries(catalog: AgentProfilesCatalog): string[] {
  return catalog.effectiveProfiles.map((entry) => {
    const profile = entry.profile;
    const ref = buildAgentProfileRef(entry.scope, profile.id);
    const details = [
      profile.description || "No description.",
      `Base role: \`${profile.baseRole}\`.`,
      profile.model ? `Default model: \`${profile.model}\`.` : "",
      profile.reasoningEffort ? `Default reasoning: \`${profile.reasoningEffort}\`.` : "",
    ].filter(Boolean);
    return `- **${profile.displayName}** (\`${ref}\`, bare ref \`${profile.id}\`): ${details.join(" ")}`;
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
