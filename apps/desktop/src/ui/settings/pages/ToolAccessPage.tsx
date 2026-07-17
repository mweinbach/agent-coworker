import { PackageIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { resolveManagementWorkspaceId } from "../../../app/workspaceDisplayTargets";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { InlineErrorBoundary } from "../../CrashReportingErrorBoundary";
import { SettingsEmptyState, SettingsStatusPill } from "../SettingsPrimitives";
import { PluginsSection } from "../toolAccess/PluginsSection";
import { SkillsSection } from "../toolAccess/SkillsSection";
import { McpServersPage } from "./McpServersPage";
import { OpenAiNativeConnectorsPage } from "./OpenAiNativeConnectorsPage";
import { ProvidersPage } from "./ProvidersPage";
import { SearchSettingsCard } from "./WorkspacesPage";

const TOOL_ACCESS_TAB_IDS = ["plugins", "skills", "connectors", "apps", "search"] as const;

type ToolAccessTabId = (typeof TOOL_ACCESS_TAB_IDS)[number];

function isToolAccessTabId(value: string): value is ToolAccessTabId {
  return (TOOL_ACCESS_TAB_IDS as readonly string[]).includes(value);
}

/** Tabs where the shell search input is hidden because the tab owns its own search UI (or has none). */
const TAB_SEARCH_PLACEHOLDER: Record<ToolAccessTabId, string | null> = {
  plugins: "Search plugins…",
  skills: "Search skills…",
  connectors: "Search connectors…",
  apps: null,
  search: null,
};

function MutationErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/5 px-4 py-3">
      <SettingsStatusPill tone="danger">Install failed</SettingsStatusPill>
      <span className="min-w-0 flex-1 truncate text-xs text-destructive">{message}</span>
      <Button size="sm" variant="outline" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

function CatalogEmptyState() {
  return (
    <SettingsEmptyState
      icon={<PackageIcon />}
      title="No workspaces yet"
      description="Add a project or start a chat first to load plugin, skill, and MCP server catalogs."
    />
  );
}

export function ToolAccessTabs() {
  const workspaceId = useToolAccessCatalogWorkspaceId();
  const openAiNativeConnectorsAvailable = useAppStore(
    (s) => s.desktopFeatureFlags.openAiNativeConnectors === true,
  );
  const workspaces = useAppStore((s) => s.workspaces);
  const runtime = useAppStore((s) =>
    workspaceId ? s.workspaceRuntimeById[workspaceId] : undefined,
  );
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const refreshPluginsCatalog = useAppStore((s) => s.refreshPluginsCatalog);
  const refreshSkillsCatalog = useAppStore((s) => s.refreshSkillsCatalog);
  const requestWorkspaceMcpServers = useAppStore((s) => s.requestWorkspaceMcpServers);
  const dismissPluginMutationError = useAppStore((s) => s.dismissPluginMutationError);
  const dismissSkillMutationError = useAppStore((s) => s.dismissSkillMutationError);

  const [activeTab, setActiveTab] = useState<ToolAccessTabId>("plugins");
  const [searchQuery, setSearchQuery] = useState("");

  // Load every catalog up front so tab counts are populated regardless of
  // which tab is active. Sections don't refetch on mount; the Connectors tab
  // re-requests through its own anchor, which is an idempotent read.
  useEffect(() => {
    if (!workspaceId) return;
    void refreshPluginsCatalog();
    void refreshSkillsCatalog(workspaceId);
    void requestWorkspaceMcpServers(workspaceId);
  }, [workspaceId, refreshPluginsCatalog, refreshSkillsCatalog, requestWorkspaceMcpServers]);

  const workspace = useMemo(
    () => (workspaceId ? (workspaces.find((entry) => entry.id === workspaceId) ?? null) : null),
    [workspaces, workspaceId],
  );

  const pluginsCatalog = runtime?.pluginsCatalog ?? null;
  const skillsCatalog = runtime?.skillsCatalog ?? null;
  const mcpServerCount = runtime?.mcpServers.length ?? 0;
  const appsCount = runtime?.openAiNativeConnectors.length ?? 0;
  const pluginMutationError = runtime?.pluginMutationError ?? null;
  const skillMutationError = runtime?.skillMutationError ?? null;

  // `null` means "not loaded yet" and hides the count in the tab label. The
  // connectors/apps lists have no explicit loaded flag, so an empty list stays
  // countless instead of flashing a misleading zero.
  const tabCounts: Record<ToolAccessTabId, number | null> = {
    plugins: pluginsCatalog ? pluginsCatalog.plugins.length : null,
    // Plugin-owned skill installations are managed from the plugin detail
    // dialog, so the Skills tab only counts standalone installations.
    skills: skillsCatalog
      ? skillsCatalog.installations.filter((installation) => !installation.plugin).length
      : null,
    connectors: mcpServerCount > 0 ? mcpServerCount : null,
    apps: appsCount > 0 ? appsCount : null,
    search: null,
  };

  const tabs: Array<{ id: ToolAccessTabId; label: string }> = [
    { id: "plugins", label: "Plugins" },
    { id: "skills", label: "Skills" },
    { id: "connectors", label: "Connectors" },
    ...(openAiNativeConnectorsAvailable ? [{ id: "apps" as const, label: "Apps" }] : []),
    { id: "search", label: "Search" },
  ];

  const effectiveTab: ToolAccessTabId = tabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : "plugins";
  const searchPlaceholder = TAB_SEARCH_PLACEHOLDER[effectiveTab];

  // Only the active entry mounts (see the single TabsContent below), so
  // building the descriptors for every tab on each render stays cheap.
  const tabContent: Record<ToolAccessTabId, ReactNode> = {
    plugins: workspaceId ? (
      <PluginsSection workspaceId={workspaceId} filterQuery={searchQuery} />
    ) : (
      <CatalogEmptyState />
    ),
    skills: workspaceId ? (
      <SkillsSection workspaceId={workspaceId} filterQuery={searchQuery} />
    ) : (
      <CatalogEmptyState />
    ),
    connectors: <McpServersPage filterQuery={searchQuery} />,
    apps: <OpenAiNativeConnectorsPage />,
    search: (
      <div className="flex flex-col gap-5">
        {workspace ? (
          <SearchSettingsCard
            workspace={workspace}
            updateWorkspaceDefaults={updateWorkspaceDefaults}
            providerStatusByName={providerStatusByName}
          />
        ) : null}
        <ProvidersPage surface="tools" />
      </div>
    ),
  };

  return (
    <InlineErrorBoundary label="The tool access settings couldn't be loaded.">
      <Tabs
        value={effectiveTab}
        onValueChange={(value) => {
          if (isToolAccessTabId(value)) setActiveTab(value);
        }}
        className="gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            {tabs.map((tab) => {
              const count = tabCounts[tab.id];
              return (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                  {count !== null ? (
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {searchPlaceholder ? (
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-8 w-56 pl-8"
              />
            </div>
          ) : null}
        </div>

        {workspaceId && pluginMutationError ? (
          <MutationErrorBanner
            message={pluginMutationError}
            onDismiss={() => dismissPluginMutationError(workspaceId)}
          />
        ) : null}
        {workspaceId && skillMutationError ? (
          <MutationErrorBanner
            message={skillMutationError}
            onDismiss={() => dismissSkillMutationError(workspaceId)}
          />
        ) : null}

        {/* A single panel keyed to the active tab keeps inactive sections
            fully unmounted without relying on Radix presence transitions. */}
        <TabsContent value={effectiveTab}>{tabContent[effectiveTab]}</TabsContent>
      </Tabs>
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
