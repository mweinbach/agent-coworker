import type {
  PluginCatalogSnapshot,
  SessionEvent,
  SkillCatalogSnapshot,
} from "../../lib/wsProtocol";
import type { WorkspaceRuntime } from "../types";
import { RUNTIME } from "./runtimeState";

type SkillsCatalogEvent = Extract<SessionEvent, { type: "skills_catalog" }>;
type PluginsCatalogEvent = Extract<SessionEvent, { type: "plugins_catalog" }>;

function omitMutationPendingKeys(
  pendingKeys: Record<string, true>,
  clearedPendingKeys?: readonly string[],
): Record<string, true> {
  if (!clearedPendingKeys || clearedPendingKeys.length === 0) {
    return pendingKeys;
  }

  const nextPendingKeys = { ...pendingKeys };
  for (const key of clearedPendingKeys) {
    delete nextPendingKeys[key];
  }
  return nextPendingKeys;
}

function mergeStableAvailablePlugins(
  previousCatalog: PluginCatalogSnapshot | null,
  nextCatalog: PluginCatalogSnapshot,
  availablePluginsPartial: boolean,
): PluginCatalogSnapshot {
  const nextAvailablePlugins = nextCatalog.availablePlugins ?? [];
  if (
    !availablePluginsPartial ||
    nextAvailablePlugins.length > 0 ||
    !previousCatalog ||
    previousCatalog.availablePlugins.length === 0
  ) {
    return {
      ...nextCatalog,
      availablePlugins: nextAvailablePlugins,
    };
  }

  const installedPluginIds = new Set(nextCatalog.plugins.map((plugin) => plugin.id));
  return {
    ...nextCatalog,
    availablePlugins: previousCatalog.availablePlugins.filter(
      (plugin) => !installedPluginIds.has(plugin.id),
    ),
  };
}

function mergeStableAvailableSkills(
  previousCatalog: SkillCatalogSnapshot | null,
  nextCatalog: SkillCatalogSnapshot,
  availableSkillsPartial: boolean,
): SkillCatalogSnapshot {
  const nextAvailableSkills = nextCatalog.availableSkills ?? [];
  if (
    !availableSkillsPartial ||
    nextAvailableSkills.length > 0 ||
    !previousCatalog ||
    (previousCatalog.availableSkills?.length ?? 0) === 0
  ) {
    return { ...nextCatalog, availableSkills: nextAvailableSkills };
  }

  const installedSkillNames = new Set(nextCatalog.installations.map((skill) => skill.name));
  return {
    ...nextCatalog,
    availableSkills: previousCatalog.availableSkills.filter(
      (skill) => !installedSkillNames.has(skill.name),
    ),
  };
}

function clearedSkillMutationKeys(
  workspaceRuntimeBefore: WorkspaceRuntime | undefined,
  clearedMutationPendingKeys: readonly string[],
): boolean {
  return clearedMutationPendingKeys.some(
    (key) => workspaceRuntimeBefore?.skillMutationPendingKeys[key] === true,
  );
}

function clearedPluginMutationKeys(
  workspaceRuntimeBefore: WorkspaceRuntime | undefined,
  clearedMutationPendingKeys: readonly string[],
): boolean {
  return clearedMutationPendingKeys.some(
    (key) => workspaceRuntimeBefore?.pluginMutationPendingKeys[key] === true,
  );
}

function clearedMarketplaceMutationKeys(
  workspaceRuntimeBefore: WorkspaceRuntime | undefined,
  clearedMutationPendingKeys: readonly string[],
): boolean {
  return clearedMutationPendingKeys.some(
    (key) => workspaceRuntimeBefore?.marketplaceMutationPendingKeys[key] === true,
  );
}

export function shouldResolveSkillInstallWaiter(
  workspaceId: string,
  clearedMutationPendingKeys: readonly string[],
  workspaceRuntimeBefore: WorkspaceRuntime | undefined,
): boolean {
  const installWaiter = RUNTIME.skillInstallWaiters.get(workspaceId);
  return (
    installWaiter != null &&
    workspaceRuntimeBefore != null &&
    clearedMutationPendingKeys.includes(installWaiter.pendingKey) &&
    workspaceRuntimeBefore.skillMutationPendingKeys[installWaiter.pendingKey] === true
  );
}

export function resolveSkillInstallWaiter(workspaceId: string): void {
  const installWaiter = RUNTIME.skillInstallWaiters.get(workspaceId);
  if (!installWaiter) {
    return;
  }
  RUNTIME.skillInstallWaiters.delete(workspaceId);
  installWaiter.resolve();
}

export function resolveClearedPluginInstallWaiter(
  workspaceId: string,
  clearedMutationPendingKeys: readonly string[],
  workspaceRuntimeBefore: WorkspaceRuntime | undefined,
): void {
  const pluginInstallWaiter = RUNTIME.pluginInstallWaiters.get(workspaceId);
  if (
    pluginInstallWaiter &&
    workspaceRuntimeBefore &&
    clearedMutationPendingKeys.includes(pluginInstallWaiter.pendingKey) &&
    workspaceRuntimeBefore.pluginMutationPendingKeys[pluginInstallWaiter.pendingKey] === true
  ) {
    RUNTIME.pluginInstallWaiters.delete(workspaceId);
    pluginInstallWaiter.resolve();
  }
}

export function applySkillsCatalogEvent(
  workspaceRuntime: WorkspaceRuntime,
  workspaceRuntimeBefore: WorkspaceRuntime | undefined,
  evt: SkillsCatalogEvent,
): WorkspaceRuntime {
  const clearedMutationPendingKeys = evt.clearedMutationPendingKeys ?? [];
  const skillsCatalog = mergeStableAvailableSkills(
    workspaceRuntime.skillsCatalog,
    evt.catalog,
    evt.availableSkillsPartial === true,
  );
  const selectedInstallationId = workspaceRuntime.selectedSkillInstallationId;
  const selectedInstallation = selectedInstallationId
    ? (skillsCatalog.installations.find(
        (installation) => installation.installationId === selectedInstallationId,
      ) ?? null)
    : null;

  return {
    ...workspaceRuntime,
    skillsCatalog,
    skillCatalogLoading: false,
    skillCatalogError: null,
    skillsMutationBlocked: evt.mutationBlocked,
    skillsMutationBlockedReason: evt.mutationBlockedReason ?? null,
    skillMutationPendingKeys: omitMutationPendingKeys(
      workspaceRuntime.skillMutationPendingKeys,
      clearedMutationPendingKeys,
    ),
    pluginMutationPendingKeys: omitMutationPendingKeys(
      workspaceRuntime.pluginMutationPendingKeys,
      clearedMutationPendingKeys,
    ),
    marketplaceMutationPendingKeys: omitMutationPendingKeys(
      workspaceRuntime.marketplaceMutationPendingKeys,
      clearedMutationPendingKeys,
    ),
    ...(clearedSkillMutationKeys(workspaceRuntimeBefore, clearedMutationPendingKeys)
      ? { skillMutationError: null }
      : {}),
    ...(clearedPluginMutationKeys(workspaceRuntimeBefore, clearedMutationPendingKeys)
      ? { pluginMutationError: null }
      : {}),
    ...(clearedMarketplaceMutationKeys(workspaceRuntimeBefore, clearedMutationPendingKeys)
      ? { marketplaceMutationError: null }
      : {}),
    selectedSkillInstallationId: selectedInstallation ? selectedInstallationId : null,
    selectedSkillInstallation: selectedInstallation,
  };
}

export function applyPluginsCatalogEvent(
  workspaceRuntime: WorkspaceRuntime,
  workspaceRuntimeBefore: WorkspaceRuntime | undefined,
  evt: PluginsCatalogEvent,
): WorkspaceRuntime {
  const clearedMutationPendingKeys = evt.clearedMutationPendingKeys ?? [];
  const pluginsCatalog = mergeStableAvailablePlugins(
    workspaceRuntime.pluginsCatalog,
    evt.catalog,
    evt.availablePluginsPartial === true,
  );
  const catalogPlugins = [...pluginsCatalog.plugins, ...pluginsCatalog.availablePlugins];
  const selectedPluginId = workspaceRuntime.selectedPluginId;
  const selectedPluginScope = workspaceRuntime.selectedPluginScope;
  const selectedPlugin = selectedPluginId
    ? (catalogPlugins.find(
        (plugin) =>
          plugin.id === selectedPluginId &&
          (selectedPluginScope === null || plugin.scope === selectedPluginScope),
      ) ?? null)
    : null;

  return {
    ...workspaceRuntime,
    pluginsCatalog,
    pluginsLoading: false,
    pluginsError: null,
    pluginMutationPendingKeys: omitMutationPendingKeys(
      workspaceRuntime.pluginMutationPendingKeys,
      clearedMutationPendingKeys,
    ),
    marketplaceMutationPendingKeys: omitMutationPendingKeys(
      workspaceRuntime.marketplaceMutationPendingKeys,
      clearedMutationPendingKeys,
    ),
    ...(clearedPluginMutationKeys(workspaceRuntimeBefore, clearedMutationPendingKeys)
      ? { pluginMutationError: null }
      : {}),
    ...(clearedMarketplaceMutationKeys(workspaceRuntimeBefore, clearedMutationPendingKeys)
      ? { marketplaceMutationError: null }
      : {}),
    selectedPluginId: selectedPlugin ? selectedPluginId : null,
    selectedPluginScope: selectedPlugin?.scope ?? null,
    selectedPlugin,
  };
}
