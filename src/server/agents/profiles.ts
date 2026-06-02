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
  agentProfileCopyInputSchema,
  agentProfileIdSchema,
  agentProfileScopeSchema,
  agentProfileUpsertInputSchema,
  buildAgentProfileRef,
  createAgentProfileSnapshot,
  normalizeAgentProfileDefinition,
  parseAgentProfileRef,
} from "../../shared/agentProfiles";
import type { AgentConfig } from "../../types";

const PROFILE_DIR_NAME = "agent-profiles";

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
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = normalizeAgentProfileDefinition(JSON.parse(raw));
      entries.push({
        scope,
        path: filePath,
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
  const [globalProfiles, workspaceProfiles] = await Promise.all([
    readScope(config, "global"),
    readScope(config, "workspace"),
  ]);

  const workspaceIds = new Set(workspaceProfiles.entries.map((entry) => entry.profile.id));
  const profiles = [...workspaceProfiles.entries, ...globalProfiles.entries].map((entry) => {
    const shadowed = entry.scope === "global" && workspaceIds.has(entry.profile.id);
    return {
      ...entry,
      shadowed,
      effective: entry.scope === "workspace" || !shadowed,
    };
  });

  const effectiveProfiles = profiles.filter((entry) => entry.effective && entry.profile.enabled);
  return {
    profiles,
    effectiveProfiles,
    diagnostics: [...workspaceProfiles.diagnostics, ...globalProfiles.diagnostics],
    roots: {
      globalDir: getAgentProfileDir(config, "global"),
      workspaceDir: getAgentProfileDir(config, "workspace"),
    },
  };
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
  const candidates =
    ref.kind === "scoped"
      ? catalog.profiles.filter((entry) => entry.scope === ref.scope && entry.profile.id === ref.id)
      : catalog.profiles.filter((entry) => entry.effective && entry.profile.id === ref.id);
  return candidates[0] ?? null;
}

async function writeProfileFile(
  config: AgentConfig,
  scope: AgentProfileScope,
  profile: AgentProfileDefinition,
): Promise<void> {
  const normalized = normalizeAgentProfileDefinition(profile);
  const dir = getAgentProfileDir(config, scope);
  await fs.mkdir(dir, { recursive: true });
  const filePath = profilePathForId(config, scope, normalized.id);
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
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
