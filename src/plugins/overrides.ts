import fs from "node:fs/promises";
import path from "node:path";
import { getAiCoworkerPaths } from "../connect";
import type { AgentConfig, PluginCatalogEntry, PluginScope } from "../types";
import { resolveCoworkHomedir } from "../utils/coworkHome";
import { nowIso } from "../utils/typeGuards";
import { canonicalDefaultMarketplacePluginIdForTombstone } from "./remoteMarketplace";

type PluginScopeOverrides = {
  plugins?: Record<string, boolean>;
  skills?: Record<string, boolean>;
  mcpServers?: Record<string, boolean>;
  removedDefaultPlugins?: Record<string, boolean>;
};

type PluginOverrideDocument = {
  version: number;
  updatedAt: string;
  plugins?: PluginScopeOverrides["plugins"];
  skills?: PluginScopeOverrides["skills"];
  mcpServers?: PluginScopeOverrides["mcpServers"];
  removedDefaultPlugins?: PluginScopeOverrides["removedDefaultPlugins"];
};

export type PluginOverrideSnapshot = {
  workspace: PluginScopeOverrides;
  user: PluginScopeOverrides;
  plugins: Record<string, { enabled?: boolean }>;
  skills: Record<string, Record<string, { enabled?: boolean }>>;
  mcpServers: Record<string, Record<string, { enabled?: boolean }>>;
  removedDefaultPlugins: Record<string, { removed?: boolean }>;
};

const CURRENT_DOCUMENT_VERSION = 2;

const DEFAULT_DOCUMENT: PluginOverrideDocument = {
  version: CURRENT_DOCUMENT_VERSION,
  updatedAt: nowIso(),
  plugins: {},
  skills: {},
  mcpServers: {},
  removedDefaultPlugins: {},
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

function normalizeDefaultPluginTombstones(value: unknown): Record<string, boolean> {
  const normalized: Record<string, boolean> = {};
  for (const [pluginId, removed] of Object.entries(normalizeBooleanMap(value))) {
    if (!removed) continue;
    const defaultPluginId = canonicalDefaultMarketplacePluginIdForTombstone(pluginId);
    if (!defaultPluginId) continue;
    normalized[defaultPluginId] = true;
  }
  return normalized;
}

function extractLegacyDefaultPluginTombstones(
  version: number,
  pluginOverrides: Record<string, boolean>,
): Record<string, boolean> {
  if (version >= CURRENT_DOCUMENT_VERSION) {
    return {};
  }
  const tombstones: Record<string, boolean> = {};
  for (const [pluginId, enabled] of Object.entries(pluginOverrides)) {
    if (enabled) continue;
    const defaultPluginId = canonicalDefaultMarketplacePluginIdForTombstone(pluginId);
    if (!defaultPluginId) continue;
    tombstones[defaultPluginId] = true;
  }
  return tombstones;
}

function removeMigratedDefaultPluginTombstones(
  version: number,
  pluginOverrides: Record<string, boolean>,
): Record<string, boolean> {
  if (version >= CURRENT_DOCUMENT_VERSION) {
    return pluginOverrides;
  }
  return Object.fromEntries(
    Object.entries(pluginOverrides).filter(
      ([pluginId, enabled]) =>
        enabled || !canonicalDefaultMarketplacePluginIdForTombstone(pluginId),
    ),
  );
}

function normalizeDocument(value: unknown): PluginOverrideDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ...DEFAULT_DOCUMENT, updatedAt: nowIso() };
  const record = value as Record<string, unknown>;
  const version =
    typeof record.version === "number" && Number.isInteger(record.version) && record.version > 0
      ? record.version
      : 1;
  const pluginOverrides = normalizeBooleanMap(record.plugins);
  const migratedTombstones = extractLegacyDefaultPluginTombstones(version, pluginOverrides);
  return {
    version: CURRENT_DOCUMENT_VERSION,
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0
        ? record.updatedAt
        : nowIso(),
    plugins: removeMigratedDefaultPluginTombstones(version, pluginOverrides),
    skills: normalizeBooleanMap(record.skills),
    mcpServers: normalizeBooleanMap(record.mcpServers),
    removedDefaultPlugins: {
      ...migratedTombstones,
      ...normalizeDefaultPluginTombstones(record.removedDefaultPlugins),
    },
  };
}

function buildConfigPaths(config: AgentConfig): { workspace: string; user: string } {
  const workspaceRoot = path.dirname(config.projectCoworkDir);
  const userHome = resolveCoworkHomedir(config.userCoworkDir);
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

function pluginMcpServerOverrideKey(pluginId: string, serverName: string): string {
  return `${pluginOverrideKey(pluginId)}:${serverName.trim()}`;
}

function scopeOverridesFromDocument(doc: PluginOverrideDocument): PluginScopeOverrides {
  return {
    plugins: { ...(doc.plugins ?? {}) },
    skills: { ...(doc.skills ?? {}) },
    mcpServers: { ...(doc.mcpServers ?? {}) },
    removedDefaultPlugins: { ...(doc.removedDefaultPlugins ?? {}) },
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
  const byMcpServer: PluginOverrideSnapshot["mcpServers"] = {};
  const byRemovedDefaultPlugin: PluginOverrideSnapshot["removedDefaultPlugins"] = {};
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
    bySkill[pluginId][rawSkillName] = { enabled };
  }
  for (const [compoundKey, enabled] of Object.entries(userDoc.skills ?? {})) {
    const [pluginId, ...rest] = compoundKey.split(":");
    const rawSkillName = rest.join(":");
    if (!pluginId || !rawSkillName) continue;
    bySkill[pluginId] ??= {};
    bySkill[pluginId][rawSkillName] = { enabled };
  }
  for (const [compoundKey, enabled] of Object.entries(workspaceDoc.mcpServers ?? {})) {
    const [pluginId, ...rest] = compoundKey.split(":");
    const serverName = rest.join(":");
    if (!pluginId || !serverName) continue;
    byMcpServer[pluginId] ??= {};
    byMcpServer[pluginId][serverName] = { enabled };
  }
  for (const [compoundKey, enabled] of Object.entries(userDoc.mcpServers ?? {})) {
    const [pluginId, ...rest] = compoundKey.split(":");
    const serverName = rest.join(":");
    if (!pluginId || !serverName) continue;
    byMcpServer[pluginId] ??= {};
    byMcpServer[pluginId][serverName] = { enabled };
  }
  for (const [pluginId, removed] of Object.entries(workspaceDoc.removedDefaultPlugins ?? {})) {
    byRemovedDefaultPlugin[pluginId] = { removed };
  }
  for (const [pluginId, removed] of Object.entries(userDoc.removedDefaultPlugins ?? {})) {
    byRemovedDefaultPlugin[pluginId] = { removed };
  }
  return {
    workspace: scopeOverridesFromDocument(workspaceDoc),
    user: scopeOverridesFromDocument(userDoc),
    plugins: byPlugin,
    skills: bySkill,
    mcpServers: byMcpServer,
    removedDefaultPlugins: byRemovedDefaultPlugin,
  };
}

export function isPluginEnabled(
  entry: PluginCatalogEntry,
  overrides: PluginOverrideSnapshot,
): boolean {
  const overrideMap =
    entry.scope === "workspace" ? overrides.workspace.plugins : overrides.user.plugins;
  const override = overrideMap?.[pluginOverrideKey(entry.id)];
  return override ?? true;
}

export function isPluginSkillEnabled(
  pluginId: string,
  pluginScope: PluginScope,
  rawSkillName: string,
  overrides: PluginOverrideSnapshot,
): boolean {
  const overrideMap =
    pluginScope === "workspace" ? overrides.workspace.skills : overrides.user.skills;
  const override = overrideMap?.[pluginSkillOverrideKey(pluginId, rawSkillName)];
  return override ?? true;
}

export function isPluginMcpServerEnabled(
  pluginId: string,
  pluginScope: PluginScope,
  serverName: string,
  overrides: PluginOverrideSnapshot,
  defaultEnabled = true,
): boolean {
  const overrideMap =
    pluginScope === "workspace" ? overrides.workspace.mcpServers : overrides.user.mcpServers;
  const override = overrideMap?.[pluginMcpServerOverrideKey(pluginId, serverName)];
  return override ?? defaultEnabled;
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
    version: CURRENT_DOCUMENT_VERSION,
    updatedAt: nowIso(),
    plugins: { ...(current.plugins ?? {}) },
    skills: { ...(current.skills ?? {}) },
    mcpServers: { ...(current.mcpServers ?? {}) },
    removedDefaultPlugins: { ...(current.removedDefaultPlugins ?? {}) },
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

export async function clearPluginEnabledOverride(opts: {
  config: AgentConfig;
  pluginId: string;
  scope: PluginScope;
}): Promise<void> {
  const normalizedId = pluginOverrideKey(opts.pluginId);
  await mutateScopeDocument(opts.config, opts.scope, (doc) => {
    if (!doc.plugins) return;
    delete doc.plugins[normalizedId];
  });
}

export async function setDefaultPluginRemoved(opts: {
  config: AgentConfig;
  pluginId: string;
  scope: PluginScope;
  removed: boolean;
}): Promise<void> {
  const defaultPluginId = canonicalDefaultMarketplacePluginIdForTombstone(opts.pluginId);
  if (!defaultPluginId) return;
  await mutateScopeDocument(opts.config, opts.scope, (doc) => {
    doc.removedDefaultPlugins ??= {};
    if (opts.removed) {
      doc.removedDefaultPlugins[defaultPluginId] = true;
      return;
    }
    delete doc.removedDefaultPlugins[defaultPluginId];
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

export async function setPluginMcpServerEnabled(opts: {
  config: AgentConfig;
  pluginId: string;
  scope: PluginScope;
  serverName: string;
  enabled: boolean;
}): Promise<void> {
  const normalizedKey = pluginMcpServerOverrideKey(opts.pluginId, opts.serverName);
  await mutateScopeDocument(opts.config, opts.scope, (doc) => {
    doc.mcpServers ??= {};
    doc.mcpServers[normalizedKey] = opts.enabled;
  });
}
