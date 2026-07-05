import { DownloadIcon, StoreIcon } from "lucide-react";
import { useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import type { MarketplaceSkillCatalogEntry, PluginCatalogEntry } from "../../../lib/wsProtocol";
import { EntityIcon, SettingsEmptyState, SettingsSection } from "../SettingsPrimitives";
import { matchesQuery, NoMatchesState, pluginIcon, skillIcon } from "./catalogShared";

type MarketplacePluginEntry = Extract<PluginCatalogEntry, { installed: false }>;

export function MarketplaceSection({
  workspaceId,
  filterQuery,
}: {
  workspaceId: string;
  filterQuery: string;
}) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const installPlugins = useAppStore((s) => s.installPlugins);
  const installSkills = useAppStore((s) => s.installSkills);

  const pluginsCatalog = runtime?.pluginsCatalog ?? null;
  const skillsCatalog = runtime?.skillsCatalog ?? null;
  const pluginsLoading = runtime?.pluginsLoading ?? false;
  const skillsLoading = runtime?.skillCatalogLoading ?? false;
  const pluginPendingKeys = runtime?.pluginMutationPendingKeys ?? {};
  const skillPendingKeys = runtime?.skillMutationPendingKeys ?? {};

  const availablePlugins = useMemo(() => {
    return [...(pluginsCatalog?.availablePlugins ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [pluginsCatalog]);

  const availableSkills = useMemo(() => {
    return [...(skillsCatalog?.availableSkills ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [skillsCatalog]);

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
  const visibleSkills = useMemo(() => {
    if (!normalizedQuery) return availableSkills;
    return availableSkills.filter((skill) =>
      matchesQuery(normalizedQuery, skill.displayName, skill.description, skill.category),
    );
  }, [availableSkills, normalizedQuery]);

  const pluginInstallPending = Object.keys(pluginPendingKeys).some((key) =>
    key.startsWith("plugin:install:"),
  );
  const skillInstallPending = Object.keys(skillPendingKeys).some((key) =>
    key.startsWith("install:"),
  );

  const marketplaceLoading =
    (pluginsLoading && pluginsCatalog === null) || (skillsLoading && skillsCatalog === null);
  const marketplaceEmpty = availablePlugins.length === 0 && availableSkills.length === 0;
  const noMatches = !marketplaceEmpty && visiblePlugins.length === 0 && visibleSkills.length === 0;

  return (
    <SettingsSection
      title="Marketplace"
      description="Plugins and skills available to install from configured marketplaces."
    >
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
        ) : noMatches ? (
          <NoMatchesState query={filterQuery.trim()} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visiblePlugins.map((plugin: MarketplacePluginEntry) => (
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
                      // Failures surface via the `pluginMutationError` banner in the tab shell.
                    })
                  }
                >
                  <DownloadIcon data-icon="inline-start" />
                  Install
                </Button>
              </article>
            ))}
            {visibleSkills.map((skill: MarketplaceSkillCatalogEntry) => (
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
                      // Failures surface via the `skillMutationError` banner in the tab shell.
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
  );
}
