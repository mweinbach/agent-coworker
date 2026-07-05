import { RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { Switch } from "../../../components/ui/switch";
import type { SkillInstallationEntry } from "../../../lib/wsProtocol";
import {
  EntityIcon,
  SettingsEmptyState,
  SettingsSection,
  SettingsStatusPill,
} from "../SettingsPrimitives";
import { AddMarketplaceDialog } from "./AddMarketplaceDialog";
import { matchesQuery, NoMatchesState, skillIcon } from "./catalogShared";
import { ImportDialog } from "./ImportDialog";
import { InstallSkillDialog } from "./InstallSkillDialog";
import { AvailableSkillsGrid, MarketplaceSourcesList } from "./marketplaceCatalog";
import { SkillDetailDialog } from "./SkillDetailDialog";
import { scopeLabel } from "./skillUtils";

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

export function SkillsSection({
  workspaceId,
  filterQuery,
}: {
  workspaceId: string;
  filterQuery: string;
}) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const refreshSkillsCatalog = useAppStore((s) => s.refreshSkillsCatalog);
  const selectSkillInstallation = useAppStore((s) => s.selectSkillInstallation);
  const enableSkillInstallation = useAppStore((s) => s.enableSkillInstallation);
  const disableSkillInstallation = useAppStore((s) => s.disableSkillInstallation);

  const skillsCatalog = runtime?.skillsCatalog ?? null;
  const skillsLoading = runtime?.skillCatalogLoading ?? false;
  const skillsError = runtime?.skillCatalogError ?? null;
  const skillPendingKeys = runtime?.skillMutationPendingKeys ?? {};

  // Plugin-owned installations are managed from the plugin's detail dialog.
  const skillInstallations = useMemo(() => {
    return (skillsCatalog?.installations ?? [])
      .filter((installation) => !installation.plugin)
      .sort((left, right) => {
        const leftActive = left.state === "effective" ? 0 : 1;
        const rightActive = right.state === "effective" ? 0 : 1;
        if (leftActive !== rightActive) return leftActive - rightActive;
        return `${left.name}:${left.scope}:${left.installationId}`.localeCompare(
          `${right.name}:${right.scope}:${right.installationId}`,
        );
      });
  }, [skillsCatalog]);

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const visibleInstallations = useMemo(() => {
    if (!normalizedQuery) return skillInstallations;
    return skillInstallations.filter((installation) =>
      matchesQuery(
        normalizedQuery,
        installation.interface?.displayName,
        installation.name,
        installation.description,
      ),
    );
  }, [skillInstallations, normalizedQuery]);

  const skillTogglePending = (installation: SkillInstallationEntry) =>
    skillPendingKeys[`enable:${installation.installationId}`] === true ||
    skillPendingKeys[`disable:${installation.installationId}`] === true;

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        title="Skills"
        description="Skills installed in this project or your library. Skills bundled by plugins are managed from the plugin."
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
              description="Install a skill from the marketplace, a GitHub URL, or import one from another tool."
            />
          </div>
        ) : visibleInstallations.length === 0 && !skillsError ? (
          <NoMatchesState query={filterQuery.trim()} />
        ) : (
          visibleInstallations.map((installation) => {
            const displayName = installation.interface?.displayName || installation.name;
            const togglePending = skillTogglePending(installation);
            const canToggle = installation.writable;
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
      <SettingsSection
        title="Marketplace"
        description="Skills available to install from your marketplaces."
        action={<AddMarketplaceDialog workspaceId={workspaceId} />}
      >
        <AvailableSkillsGrid workspaceId={workspaceId} filterQuery={filterQuery} />
      </SettingsSection>
      <MarketplaceSourcesList workspaceId={workspaceId} />
      <SkillDetailDialog workspaceId={workspaceId} />
    </div>
  );
}
