import { DownloadIcon, PackageIcon, RefreshCwIcon, SparklesIcon, StoreIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { resolveManagementWorkspaceId } from "../../../app/workspaceDisplayTargets";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { Switch } from "../../../components/ui/switch";
import type {
  MarketplaceSkillCatalogEntry,
  PluginCatalogEntry,
  SkillInstallationEntry,
} from "../../../lib/wsProtocol";
import { InlineErrorBoundary } from "../../CrashReportingErrorBoundary";
import {
  EntityIcon,
  SettingsEmptyState,
  SettingsSection,
  SettingsStatusPill,
} from "../SettingsPrimitives";
import { ImportDialog } from "../toolAccess/ImportDialog";
import { InstallPluginDialog } from "../toolAccess/InstallPluginDialog";
import { InstallSkillDialog } from "../toolAccess/InstallSkillDialog";
import { PluginDetailDialog } from "../toolAccess/PluginDetailDialog";
import { SkillDetailDialog } from "../toolAccess/SkillDetailDialog";
import { scopeLabel } from "../toolAccess/skillUtils";

type InstalledPluginEntry = Extract<PluginCatalogEntry, { installed: true }>;
type MarketplacePluginEntry = Extract<PluginCatalogEntry, { installed: false }>;

function pluginIcon(plugin: PluginCatalogEntry): string | undefined {
  return plugin.interface?.logo ?? plugin.interface?.composerIcon;
}

function skillIcon(entry: {
  interface?: { iconSmall?: string; iconLarge?: string };
}): string | undefined {
  return entry.interface?.iconSmall ?? entry.interface?.iconLarge;
}

function skillStateLabel(state: SkillInstallationEntry["state"]): string {
  switch (state) {
    case "effective":
      return "Active";
    case "disabled":
      return "Disabled";
    case "shadowed":
      return "Shadowed";
    case "invalid":
      return "Invalid";
    default:
      return state;
  }
}

export function ToolAccessCatalogSections({ workspaceId }: { workspaceId: string }) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const refreshPluginsCatalog = useAppStore((s) => s.refreshPluginsCatalog);
  const refreshSkillsCatalog = useAppStore((s) => s.refreshSkillsCatalog);
  const selectPlugin = useAppStore((s) => s.selectPlugin);
  const selectSkillInstallation = useAppStore((s) => s.selectSkillInstallation);
  const enablePlugin = useAppStore((s) => s.enablePlugin);
  const disablePlugin = useAppStore((s) => s.disablePlugin);
  const enableSkillInstallation = useAppStore((s) => s.enableSkillInstallation);
  const disableSkillInstallation = useAppStore((s) => s.disableSkillInstallation);
  const installPlugins = useAppStore((s) => s.installPlugins);
  const installSkills = useAppStore((s) => s.installSkills);
  const dismissPluginMutationError = useAppStore((s) => s.dismissPluginMutationError);
  const dismissSkillMutationError = useAppStore((s) => s.dismissSkillMutationError);

  useEffect(() => {
    void refreshPluginsCatalog();
    void refreshSkillsCatalog(workspaceId);
  }, [workspaceId, refreshPluginsCatalog, refreshSkillsCatalog]);

  const pluginsCatalog = runtime?.pluginsCatalog ?? null;
  const skillsCatalog = runtime?.skillsCatalog ?? null;
  const pluginsLoading = runtime?.pluginsLoading ?? false;
  const skillsLoading = runtime?.skillCatalogLoading ?? false;
  const pluginsError = runtime?.pluginsError ?? null;
  const skillsError = runtime?.skillCatalogError ?? null;
  const pluginMutationError = runtime?.pluginMutationError ?? null;
  const skillMutationError = runtime?.skillMutationError ?? null;
  const pluginPendingKeys = runtime?.pluginMutationPendingKeys ?? {};
  const skillPendingKeys = runtime?.skillMutationPendingKeys ?? {};

  const installedPlugins = useMemo(() => {
    return [...(pluginsCatalog?.plugins ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [pluginsCatalog]);

  const availablePlugins = useMemo(() => {
    return [...(pluginsCatalog?.availablePlugins ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [pluginsCatalog]);

  const skillInstallations = useMemo(() => {
    return [...(skillsCatalog?.installations ?? [])].sort((left, right) => {
      const leftActive = left.state === "effective" ? 0 : 1;
      const rightActive = right.state === "effective" ? 0 : 1;
      if (leftActive !== rightActive) return leftActive - rightActive;
      return `${left.name}:${left.scope}:${left.installationId}`.localeCompare(
        `${right.name}:${right.scope}:${right.installationId}`,
      );
    });
  }, [skillsCatalog]);

  const availableSkills = useMemo(() => {
    return [...(skillsCatalog?.availableSkills ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [skillsCatalog]);

  const pluginInstallPending = Object.keys(pluginPendingKeys).some((key) =>
    key.startsWith("plugin:install:"),
  );
  const skillInstallPending = Object.keys(skillPendingKeys).some((key) =>
    key.startsWith("install:"),
  );

  const pluginTogglePending = (plugin: InstalledPluginEntry) =>
    pluginPendingKeys[`plugin:enable:${plugin.scope}:${plugin.id}`] === true ||
    pluginPendingKeys[`plugin:disable:${plugin.scope}:${plugin.id}`] === true;

  const skillTogglePending = (installation: SkillInstallationEntry) =>
    skillPendingKeys[`enable:${installation.installationId}`] === true ||
    skillPendingKeys[`disable:${installation.installationId}`] === true;

  const marketplaceLoading =
    (pluginsLoading && pluginsCatalog === null) || (skillsLoading && skillsCatalog === null);
  const marketplaceEmpty = availablePlugins.length === 0 && availableSkills.length === 0;

  return (
    <InlineErrorBoundary label="The plugin and skill catalogs couldn't be loaded.">
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
              description="Install a plugin from the marketplace below, a GitHub URL, or import one from another tool."
            />
          </div>
        ) : (
          installedPlugins.map((plugin) => {
            const togglePending = pluginTogglePending(plugin);
            return (
              <div
                key={`${plugin.scope}:${plugin.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-card/60"
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
              </div>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        title="Marketplace"
        description="Plugins and skills available to install from configured marketplaces."
      >
        {pluginMutationError ? (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <SettingsStatusPill tone="danger">Install failed</SettingsStatusPill>
            <span className="min-w-0 flex-1 truncate text-xs text-destructive">
              {pluginMutationError}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => dismissPluginMutationError(workspaceId)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        {skillMutationError ? (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <SettingsStatusPill tone="danger">Install failed</SettingsStatusPill>
            <span className="min-w-0 flex-1 truncate text-xs text-destructive">
              {skillMutationError}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => dismissSkillMutationError(workspaceId)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        <div className="px-4 py-3.5">
          {marketplaceLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : marketplaceEmpty ? (
            <SettingsEmptyState
              icon={<StoreIcon />}
              title="Nothing left to install"
              description="Every marketplace plugin and skill is already installed, or no marketplace is configured."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {availablePlugins.map((plugin: MarketplacePluginEntry) => (
                <article
                  key={`plugin:${plugin.id}`}
                  className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border/55 bg-background/45 p-3.5"
                >
                  <div className="flex items-start gap-3">
                    <EntityIcon src={pluginIcon(plugin)} name={plugin.displayName} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {plugin.displayName}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        Plugin
                        {plugin.marketplace.category ? ` · ${plugin.marketplace.category}` : ""}
                      </div>
                    </div>
                  </div>
                  <p className="line-clamp-2 flex-1 text-xs text-muted-foreground">
                    {plugin.interface?.shortDescription || plugin.description}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="self-start"
                    disabled={pluginInstallPending}
                    onClick={() =>
                      void installPlugins(plugin.installSource, "user").catch(() => {
                        // Failures surface via the `pluginMutationError` banner above.
                      })
                    }
                  >
                    <DownloadIcon data-icon="inline-start" />
                    Install
                  </Button>
                </article>
              ))}
              {availableSkills.map((skill: MarketplaceSkillCatalogEntry) => (
                <article
                  key={`skill:${skill.id}`}
                  className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border/55 bg-background/45 p-3.5"
                >
                  <div className="flex items-start gap-3">
                    <EntityIcon src={skillIcon(skill)} name={skill.displayName} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {skill.interface?.displayName || skill.displayName}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        Skill{skill.category ? ` · ${skill.category}` : ""}
                      </div>
                    </div>
                  </div>
                  <p className="line-clamp-2 flex-1 text-xs text-muted-foreground">
                    {skill.interface?.shortDescription || skill.description}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="self-start"
                    disabled={skillInstallPending}
                    onClick={() =>
                      void installSkills(skill.installSource, "global").catch(() => {
                        // Failures surface via the `skillMutationError` banner above.
                      })
                    }
                  >
                    <DownloadIcon data-icon="inline-start" />
                    Install
                  </Button>
                </article>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Skills"
        description="Installed skills across workspace, library, and plugin scopes. Click a skill for details, updates, and removal."
        action={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refreshSkillsCatalog(workspaceId)}
            >
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
            <ImportDialog workspaceId={workspaceId} kind="skill" />
            <InstallSkillDialog workspaceId={workspaceId} />
          </>
        }
      >
        {skillsError ? (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <SettingsStatusPill tone="danger">Connection issue</SettingsStatusPill>
            <span className="min-w-0 flex-1 truncate text-xs text-destructive">{skillsError}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshSkillsCatalog(workspaceId)}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {skillsLoading && skillsCatalog === null ? (
          <div className="space-y-3 px-4 py-3.5">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : skillInstallations.length === 0 && !skillsError ? (
          <div className="p-4">
            <SettingsEmptyState
              icon={<SparklesIcon />}
              title="No skills installed"
              description="Install a skill from the marketplace above, a GitHub URL, or import one from another tool."
            />
          </div>
        ) : (
          skillInstallations.map((installation) => {
            const displayName = installation.interface?.displayName || installation.name;
            const togglePending = skillTogglePending(installation);
            const canToggle = installation.writable && !installation.plugin;
            return (
              <div
                key={installation.installationId}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-card/60"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => void selectSkillInstallation(installation.installationId)}
                >
                  <EntityIcon src={skillIcon(installation)} name={displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {displayName}
                      </span>
                      {installation.state !== "effective" ? (
                        <SettingsStatusPill
                          tone={installation.state === "invalid" ? "danger" : "neutral"}
                        >
                          {skillStateLabel(installation.state)}
                        </SettingsStatusPill>
                      ) : null}
                      {installation.updateAvailable ? (
                        <SettingsStatusPill tone="warning">Update available</SettingsStatusPill>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {installation.interface?.shortDescription || installation.description}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {scopeLabel(installation.scope)}
                      {installation.plugin ? ` · ${installation.plugin.displayName}` : ""}
                      {!installation.writable ? " · Read-only" : ""}
                    </span>
                  </span>
                </button>
                <Switch
                  checked={installation.enabled}
                  disabled={!canToggle || togglePending}
                  aria-label={`Enable ${displayName}`}
                  onCheckedChange={(enabled) => {
                    if (enabled) {
                      void enableSkillInstallation(installation.installationId);
                    } else {
                      void disableSkillInstallation(installation.installationId);
                    }
                  }}
                />
              </div>
            );
          })
        )}
      </SettingsSection>

      <PluginDetailDialog workspaceId={workspaceId} />
      <SkillDetailDialog workspaceId={workspaceId} />
    </InlineErrorBoundary>
  );
}

export function useToolAccessCatalogWorkspaceId(): string | null {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  return useMemo(
    () => resolveManagementWorkspaceId(workspaces, selectedWorkspaceId),
    [workspaces, selectedWorkspaceId],
  );
}
