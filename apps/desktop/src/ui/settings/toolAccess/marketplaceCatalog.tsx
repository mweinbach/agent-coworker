import { DownloadIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { marketplaceRemovePendingKey } from "../../../app/store.actions/marketplaces";
import type { MarketplacesListEntry } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { confirmAction } from "../../../lib/desktopCommands";
import type { PluginCatalogEntry } from "../../../lib/wsProtocol";
import { EntityIcon, SettingsSection } from "../SettingsPrimitives";
import { matchesQuery, NoMatchesState, pluginIcon, skillIcon } from "./catalogShared";
import { MarketplaceDetailDialog } from "./MarketplaceDetailDialog";

type MarketplacePluginEntry = Extract<PluginCatalogEntry, { installed: false }>;

function MarketplaceCard({
  icon,
  name,
  kindLine,
  description,
  installDisabled,
  onInstall,
}: {
  icon: string | undefined;
  name: string;
  kindLine: string;
  description: string;
  installDisabled: boolean;
  onInstall: () => void;
}) {
  return (
    <article className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border/55 bg-background/45 p-3.5">
      <div className="flex items-start gap-3">
        <EntityIcon src={icon} name={name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{kindLine}</div>
        </div>
      </div>
      <p className="line-clamp-2 flex-1 text-xs text-muted-foreground">{description}</p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="self-start"
        disabled={installDisabled}
        onClick={onInstall}
      >
        <DownloadIcon data-icon="inline-start" />
        Install
      </Button>
    </article>
  );
}

function CardGridSkeleton() {
  return (
    <div className="grid gap-3 px-4 py-3.5 sm:grid-cols-2 xl:grid-cols-3">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

/**
 * Not-yet-installed skills from configured marketplaces, rendered inside the
 * Skills tab's "Marketplace" section. Always renders something: the hosting
 * section keeps the Add marketplace affordance even when the grid is empty.
 */
export function AvailableSkillsGrid({
  workspaceId,
  filterQuery,
}: {
  workspaceId: string;
  filterQuery: string;
}) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const installSkills = useAppStore((s) => s.installSkills);

  const skillsCatalog = runtime?.skillsCatalog ?? null;
  const skillsLoading = runtime?.skillCatalogLoading ?? false;
  const skillPendingKeys = runtime?.skillMutationPendingKeys ?? {};

  const availableSkills = useMemo(() => {
    return [...(skillsCatalog?.availableSkills ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [skillsCatalog]);

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const visibleSkills = useMemo(() => {
    if (!normalizedQuery) return availableSkills;
    return availableSkills.filter((skill) =>
      matchesQuery(normalizedQuery, skill.displayName, skill.description, skill.category),
    );
  }, [availableSkills, normalizedQuery]);

  const installPending = Object.keys(skillPendingKeys).some((key) => key.startsWith("install:"));

  if (skillsLoading && skillsCatalog === null) {
    return <CardGridSkeleton />;
  }
  if (availableSkills.length === 0) {
    return (
      <div className="px-4 py-3.5 text-xs text-muted-foreground">
        Everything from your marketplaces is installed.
      </div>
    );
  }
  if (visibleSkills.length === 0) {
    return <NoMatchesState query={filterQuery.trim()} />;
  }
  return (
    <div className="grid gap-3 px-4 py-3.5 sm:grid-cols-2 xl:grid-cols-3">
      {visibleSkills.map((skill) => (
        <MarketplaceCard
          key={skill.id}
          icon={skillIcon(skill)}
          name={skill.interface?.displayName || skill.displayName}
          kindLine={`Skill${skill.category ? ` · ${skill.category}` : ""}`}
          description={skill.interface?.shortDescription || skill.description}
          installDisabled={installPending}
          onInstall={() =>
            void installSkills(skill.installSource, "global").catch(() => {
              // Failures surface via the `skillMutationError` banner in the tab shell.
            })
          }
        />
      ))}
    </div>
  );
}

/**
 * Not-yet-installed plugins from configured marketplaces, rendered below the
 * installed list in the Plugins tab. Renders nothing when no cards are visible;
 * the marketplace management affordances live in the Skills tab.
 */
export function AvailablePluginsSection({
  workspaceId,
  filterQuery,
}: {
  workspaceId: string;
  filterQuery: string;
}) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const installPlugins = useAppStore((s) => s.installPlugins);

  const pluginsCatalog = runtime?.pluginsCatalog ?? null;
  const pluginPendingKeys = runtime?.pluginMutationPendingKeys ?? {};

  const availablePlugins = useMemo(() => {
    return [...(pluginsCatalog?.availablePlugins ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [pluginsCatalog]);

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const visiblePlugins = useMemo(() => {
    if (!normalizedQuery) return availablePlugins;
    return availablePlugins.filter((plugin) =>
      matchesQuery(
        normalizedQuery,
        plugin.displayName,
        plugin.description,
        plugin.marketplace.category,
      ),
    );
  }, [availablePlugins, normalizedQuery]);

  const installPending = Object.keys(pluginPendingKeys).some((key) =>
    key.startsWith("plugin:install:"),
  );

  if (visiblePlugins.length === 0) {
    return null;
  }

  return (
    <SettingsSection
      title="Available from marketplaces"
      description="Plugins available to install from your marketplaces."
    >
      <div className="grid gap-3 px-4 py-3.5 sm:grid-cols-2 xl:grid-cols-3">
        {visiblePlugins.map((plugin: MarketplacePluginEntry) => (
          <MarketplaceCard
            key={plugin.id}
            icon={pluginIcon(plugin)}
            name={plugin.displayName}
            kindLine={`Plugin${plugin.marketplace.category ? ` · ${plugin.marketplace.category}` : ""}`}
            description={plugin.interface?.shortDescription || plugin.description}
            installDisabled={installPending}
            onInstall={() =>
              void installPlugins(plugin.installSource, "user").catch(() => {
                // Failures surface via the `pluginMutationError` banner in the tab shell.
              })
            }
          />
        ))}
      </div>
    </SettingsSection>
  );
}

function marketplaceMetaLine(entry: MarketplacesListEntry): string {
  const parts = [entry.repo];
  if (typeof entry.pluginCount === "number") {
    parts.push(`${entry.pluginCount} ${entry.pluginCount === 1 ? "plugin" : "plugins"}`);
  }
  if (typeof entry.skillCount === "number") {
    parts.push(`${entry.skillCount} ${entry.skillCount === 1 ? "skill" : "skills"}`);
  }
  return parts.join(" · ");
}

/** The configured marketplace catalogs, with per-source counts, detail dialog, and removal. */
export function MarketplaceSourcesList({ workspaceId }: { workspaceId: string }) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const refreshMarketplaces = useAppStore((s) => s.refreshMarketplaces);
  const removeMarketplace = useAppStore((s) => s.removeMarketplace);
  const selectMarketplace = useAppStore((s) => s.selectMarketplace);
  const dismissMarketplaceMutationError = useAppStore((s) => s.dismissMarketplaceMutationError);

  // The sources list is only served by `cowork/marketplaces/read`; available
  // items keep coming from the plugin/skill catalogs loaded by the tab shell.
  useEffect(() => {
    void refreshMarketplaces(workspaceId);
  }, [workspaceId, refreshMarketplaces]);

  const marketplaces = runtime?.marketplaces ?? null;
  const marketplacesLoading = runtime?.marketplacesLoading ?? false;
  const marketplacesError = runtime?.marketplacesError ?? null;
  const marketplacePendingKeys = runtime?.marketplaceMutationPendingKeys ?? {};
  const marketplaceMutationError = runtime?.marketplaceMutationError ?? null;

  return (
    <SettingsSection
      title="Marketplace sources"
      description="Catalogs Cowork can install plugins and skills from."
    >
      {marketplaceMutationError ? (
        <div className="flex items-center gap-3 px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-xs text-destructive">
            {marketplaceMutationError}
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => dismissMarketplaceMutationError(workspaceId)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {marketplaces === null && marketplacesLoading ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : marketplaces === null && marketplacesError ? (
        <div className="px-4 py-3.5 text-xs text-destructive">{marketplacesError}</div>
      ) : marketplaces === null || marketplaces.length === 0 ? (
        <div className="px-4 py-3.5 text-xs text-muted-foreground">No marketplaces configured.</div>
      ) : (
        marketplaces.map((entry) => {
          const displayName = entry.displayName || entry.repo;
          const removePending =
            marketplacePendingKeys[marketplaceRemovePendingKey(entry.id)] === true;
          return (
            <div
              key={entry.id}
              className={
                entry.fetchError
                  ? "flex items-center gap-3 bg-destructive/5 px-4 py-3 transition-colors hover:bg-destructive/10"
                  : "flex items-center gap-3 px-4 py-3 transition-colors hover:bg-card/60"
              }
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => void selectMarketplace(entry.id)}
              >
                <EntityIcon name={displayName} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {displayName}
                    </span>
                    {entry.builtIn ? (
                      <Badge variant="secondary" className="shrink-0">
                        Built-in
                      </Badge>
                    ) : null}
                  </span>
                  {entry.fetchError ? (
                    <span className="block truncate text-xs text-destructive">
                      Unreachable: {entry.fetchError}
                    </span>
                  ) : (
                    <span className="block truncate text-xs text-muted-foreground">
                      {marketplaceMetaLine(entry)}
                    </span>
                  )}
                </span>
              </button>
              {!entry.builtIn ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${displayName}`}
                  disabled={removePending}
                  onClick={async (event) => {
                    event.stopPropagation();
                    const confirmed = await confirmAction({
                      title: "Remove marketplace",
                      message: `Remove "${displayName}"?`,
                      detail:
                        "Plugins and skills installed from this marketplace stay installed but will no longer receive updates from it.",
                      confirmLabel: "Remove",
                      cancelLabel: "Cancel",
                      kind: "warning",
                      defaultAction: "cancel",
                    });
                    if (confirmed) {
                      void removeMarketplace(entry.id);
                    }
                  }}
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </div>
          );
        })
      )}
      <MarketplaceDetailDialog workspaceId={workspaceId} />
    </SettingsSection>
  );
}
