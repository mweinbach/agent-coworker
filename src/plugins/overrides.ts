import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, PluginCatalogEntry, PluginScope } from "../types";
import { getAiCoworkerPaths } from "../connect";
import { resolveCoworkHomedir } from "../utils/coworkHome";
import { nowIso } from "../utils/typeGuards";

type PluginScopeOverrides = {
  plugins?: Record<string, boolean>;
  skills?: Record<string, boolean>;
};

type PluginOverrideDocument = {
  version: 1;
  updatedAt: string;
  plugins?: PluginScopeOverrides["plugins"];
  skills?: PluginScopeOverrides["skills"];
};

export type PluginOverrideSnapshot = {
  workspace: PluginScopeOverrides;
  user: PluginScopeOverrides;
  plugins: Record<string, { enabled?: boolean }>;
  skills: Record<string, Record<string, { enabled?: boolean }>>;
};

const DEFAULT_DOCUMENT: PluginOverrideDocument = {
  version: 1,
  updatedAt: nowIso(),
  plugins: {},
  skills: {},
};

function normalizeBooleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || key.trim().length === 0 || typeof raw !== "boolean") continue;
    normalized[key.trim()] = raw;
  }
  return normalized;
}

function normalizeDocument(value: unknown): PluginOverrideDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_DOCUMENT, updatedAt: nowIso() };
  const record = value as Record<string, unknown>;
  return {
    version: 1,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0 ? record.updatedAt : nowIso(),
    plugins: normalizeBooleanMap(record.plugins),
    skills: normalizeBooleanMap(record.skills),
  };
}

function buildConfigPaths(config: AgentConfig): { workspace: string; user: string } {
  const workspaceRoot = path.dirname(config.projectAgentDir);
  const userHome = resolveCoworkHomedir(config.userAgentDir);
  const coworkPaths = getAiCoworkerPaths({ homedir: userHome });
  return {
    workspace: path.join(workspaceRoot, ".cowork", "plugins.json"),
    user: path.join(coworkPaths.configDir, "plugins.json"),
  };
}

async function readDocument(filePath: string): Promise<PluginOverrideDocument> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return normalizeDocument(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DOCUMENT, updatedAt: nowIso() };
  }
}

async function writeDocument(filePath: string, doc: PluginOverrideDocument): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  await fs.writeFile(filePath, payload, { encoding: "utf-8", mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort
  }
}

function pluginOverrideKey(pluginId: string): string {
  return pluginId.trim();
}

function pluginSkillOverrideKey(pluginId: string, rawSkillName: string): string {
  return `${pluginOverrideKey(pluginId)}:${rawSkillName.trim()}`;
}

function scopeOverridesFromDocument(doc: PluginOverrideDocument): PluginScopeOverrides {
  return {
    plugins: { ...(doc.plugins ?? {}) },
    skills: { ...(doc.skills ?? {}) },
  };
}

export async function readPluginOverrides(config: AgentConfig): Promise<PluginOverrideSnapshot> {
  const paths = buildConfigPaths(config);
  const [workspaceDoc, userDoc] = await Promise.all([
    readDocument(paths.workspace),
    readDocument(paths.user),
  ]);
  const byPlugin: PluginOverrideSnapshot["plugins"] = {};
  const bySkill: PluginOverrideSnapshot["skills"] = {};
  for (const [pluginId, enabled] of Object.entries(workspaceDoc.plugins ?? {})) {
    byPlugin[pluginId] = { enabled };
  }
  for (const [pluginId, enabled] of Object.entries(userDoc.plugins ?? {})) {
    byPlugin[pluginId] = { enabled };
  }
  for (const [compoundKey, enabled] of Object.entries(workspaceDoc.skills ?? {})) {
    const [pluginId, ...rest] = compoundKey.split(":");
    const rawSkillName = rest.join(":");
    if (!pluginId || !rawSkillName) continue;
    bySkill[pluginId] ??= {};
    bySkill[pluginId]![rawSkillName] = { enabled };
  }
  for (const [compoundKey, enabled] of Object.entries(userDoc.skills ?? {})) {
    const [pluginId, ...rest] = compoundKey.split(":");
    const rawSkillName = rest.join(":");
    if (!pluginId || !rawSkillName) continue;
    bySkill[pluginId] ??= {};
    bySkill[pluginId]![rawSkillName] = { enabled };
  }
  return {
    workspace: scopeOverridesFromDocument(workspaceDoc),
    user: scopeOverridesFromDocument(userDoc),
    plugins: byPlugin,
    skills: bySkill,
  };
}

export function isPluginEnabled(entry: PluginCatalogEntry, overrides: PluginOverrideSnapshot): boolean {
  const overrideMap = entry.scope === "workspace" ? overrides.workspace.plugins : overrides.user.plugins;
  const override = overrideMap?.[pluginOverrideKey(entry.id)];
  return override ?? true;
}

export function isPluginSkillEnabled(
  pluginId: string,
  pluginScope: PluginScope,
  rawSkillName: string,
  overrides: PluginOverrideSnapshot,
): boolean {
  const overrideMap = pluginScope === "workspace" ? overrides.workspace.skills : overrides.user.skills;
  const override = overrideMap?.[pluginSkillOverrideKey(pluginId, rawSkillName)];
  return override ?? true;
}

async function mutateScopeDocument(
  config: AgentConfig,
  scope: PluginScope,
  mutate: (doc: PluginOverrideDocument) => void,
): Promise<void> {
  const paths = buildConfigPaths(config);
  const filePath = scope === "workspace" ? paths.workspace : paths.user;
  const current = await readDocument(filePath);
  const next: PluginOverrideDocument = {
    version: 1,
    updatedAt: nowIso(),
    plugins: { ...(current.plugins ?? {}) },
    skills: { ...(current.skills ?? {}) },
  };
  mutate(next);
  await writeDocument(filePath, next);
}

export async function setPluginEnabled(opts: {
  config: AgentConfig;
  pluginId: string;
  scope: PluginScope;
  enabled: boolean;
}): Promise<void> {
  const normalizedId = pluginOverrideKey(opts.pluginId);
  await mutateScopeDocument(opts.config, opts.scope, (doc) => {
    doc.plugins ??= {};
    doc.plugins[normalizedId] = opts.enabled;
  });
}

export async function setPluginSkillEnabled(opts: {
  config: AgentConfig;
  pluginId: string;
  scope: PluginScope;
  rawSkillName: string;
  enabled: boolean;
}): Promise<void> {
  const normalizedKey = pluginSkillOverrideKey(opts.pluginId, opts.rawSkillName);
  await mutateScopeDocument(opts.config, opts.scope, (doc) => {
    doc.skills ??= {};
    doc.skills[normalizedKey] = opts.enabled;
  });
}
