import { PackageIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { Switch } from "../../../components/ui/switch";
import type { PluginCatalogEntry } from "../../../lib/wsProtocol";
import { OperationFeedback } from "../../OperationFeedback";
import {
  EntityIcon,
  SettingsEmptyState,
  SettingsSection,
  SettingsStatusPill,
} from "../SettingsPrimitives";
import { matchesQuery, NoMatchesState, pluginIcon } from "./catalogShared";
import { ImportDialog } from "./ImportDialog";
import { InstallPluginDialog } from "./InstallPluginDialog";
import { AvailablePluginsSection } from "./marketplaceCatalog";
import { PluginDetailDialog } from "./PluginDetailDialog";

type InstalledPluginEntry = Extract<PluginCatalogEntry, { installed: true }>;

export function PluginsSection({
  workspaceId,
  filterQuery,
}: {
  workspaceId: string;
  filterQuery: string;
}) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const refreshPluginsCatalog = useAppStore((s) => s.refreshPluginsCatalog);
  const selectPlugin = useAppStore((s) => s.selectPlugin);
  const enablePlugin = useAppStore((s) => s.enablePlugin);
  const disablePlugin = useAppStore((s) => s.disablePlugin);
  const operationsByKey = useAppStore((s) => s.operationsByKey);

  const pluginsCatalog = runtime?.pluginsCatalog ?? null;
  const pluginsLoading = runtime?.pluginsLoading ?? false;
  const pluginsError = runtime?.pluginsError ?? null;
  const pluginPendingKeys = runtime?.pluginMutationPendingKeys ?? {};

  const installedPlugins = useMemo(() => {
    return [...(pluginsCatalog?.plugins ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [pluginsCatalog]);

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const visiblePlugins = useMemo(() => {
    if (!normalizedQuery) return installedPlugins;
    return installedPlugins.filter((plugin) =>
      matchesQuery(normalizedQuery, plugin.displayName, plugin.name, plugin.description),
    );
  }, [installedPlugins, normalizedQuery]);

  const pluginTogglePending = (plugin: InstalledPluginEntry) =>
    pluginPendingKeys[`plugin:enable:${plugin.scope}:${plugin.id}`] === true ||
    pluginPendingKeys[`plugin:disable:${plugin.scope}:${plugin.id}`] === true;

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        title="Plugins"
        description="Installed plugin bundles of skills, MCP servers, and apps. Click a plugin for details, updates, and removal."
        action={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refreshPluginsCatalog()}
            >
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
            <ImportDialog workspaceId={workspaceId} kind="plugin" />
            <InstallPluginDialog workspaceId={workspaceId} />
          </>
        }
      >
        {pluginsError ? (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <SettingsStatusPill tone="danger">Connection issue</SettingsStatusPill>
            <span className="min-w-0 flex-1 truncate text-xs text-destructive">{pluginsError}</span>
            <Button size="sm" variant="outline" onClick={() => void refreshPluginsCatalog()}>
              Retry
            </Button>
          </div>
        ) : null}
        {pluginsLoading && pluginsCatalog === null ? (
          <div className="space-y-3 px-4 py-3.5">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : installedPlugins.length === 0 && !pluginsError ? (
          <div className="p-4">
            <SettingsEmptyState
              icon={<PackageIcon />}
              title="No plugins installed"
              description="Install a plugin from the marketplace, a GitHub URL, or import one from another tool."
            />
          </div>
        ) : visiblePlugins.length === 0 && !pluginsError ? (
          <NoMatchesState query={filterQuery.trim()} />
        ) : (
          visiblePlugins.map((plugin) => {
            const operation = ["enable", "disable"]
              .map(
                (action) =>
                  operationsByKey[operationKey("plugin", action, plugin.scope, plugin.id)],
              )
              .find(
                (candidate) => candidate?.status === "pending" || candidate?.status === "error",
              );
            const togglePending = pluginTogglePending(plugin) || operation?.status === "pending";
            return (
              <div
                key={`${plugin.scope}:${plugin.id}`}
                className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-card/60"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => void selectPlugin(plugin.id, plugin.scope)}
                >
                  <EntityIcon src={pluginIcon(plugin)} name={plugin.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {plugin.displayName}
                      </span>
                      {plugin.updateAvailable ? (
                        <SettingsStatusPill tone="warning">Update available</SettingsStatusPill>
                      ) : null}
                      {!plugin.enabled ? (
                        <SettingsStatusPill tone="neutral">Disabled</SettingsStatusPill>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {plugin.interface?.shortDescription || plugin.description}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {plugin.skills.length} skill{plugin.skills.length === 1 ? "" : "s"}
                      {" · "}
                      {plugin.mcpServers.length} MCP server
                      {plugin.mcpServers.length === 1 ? "" : "s"}
                      {" · "}
                      {plugin.scope === "workspace" ? "Workspace" : "Library"}
                      {plugin.marketplace?.category ? ` · ${plugin.marketplace.category}` : ""}
                    </span>
                  </span>
                </button>
                <Switch
                  checked={plugin.enabled}
                  disabled={togglePending}
                  aria-label={`Enable ${plugin.displayName}`}
                  onCheckedChange={(enabled) => {
                    if (enabled) {
                      void enablePlugin(plugin.id, plugin.scope);
                    } else {
                      void disablePlugin(plugin.id, plugin.scope);
                    }
                  }}
                />
                <OperationFeedback operation={operation} className="basis-full" />
              </div>
            );
          })
        )}
      </SettingsSection>
      <AvailablePluginsSection workspaceId={workspaceId} filterQuery={filterQuery} />
      <PluginDetailDialog workspaceId={workspaceId} />
    </div>
  );
}
