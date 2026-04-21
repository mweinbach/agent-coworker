import { useCallback, useState, type ReactNode } from "react";

import { ArrowLeftIcon } from "lucide-react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import type { SettingsPageId } from "../../app/types";
import { ProvidersPage } from "./pages/ProvidersPage";
import { UsagePage } from "./pages/UsagePage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { BackupPage } from "./pages/BackupPage";
import { McpServersPage } from "./pages/McpServersPage";
import { UpdatesPage } from "./pages/UpdatesPage";
import { DeveloperPage } from "./pages/DeveloperPage";
import { MemoryPage } from "./pages/MemoryPage";
import { RemoteAccessPage } from "./pages/RemoteAccessPage";
import { FeatureFlagsPage } from "./pages/FeatureFlagsPage";
import { SettingsChromeProvider, type SettingsChromeState } from "./SettingsChromeContext";

type SettingsPageDefinition = {
  id: SettingsPageId;
  label: string;
  render: () => ReactNode;
};

const SETTINGS_PAGE_META: Record<
  SettingsPageId,
  { title: string; description: string }
> = {
  providers: {
    title: "Providers",
    description: "Connect models and see whether each provider is ready to use.",
  },
  mcp: {
    title: "MCP servers",
    description: "Add tools and services the agent can call from this workspace.",
  },
  workspaces: {
    title: "Workspace",
    description: "Defaults for models, tools, and behavior in this project.",
  },
  memory: {
    title: "Memory",
    description: "What Cowork remembers about you and this workspace.",
  },
  remoteAccess: {
    title: "Remote access",
    description: "Pair a phone to this workspace over the relay when the app is open.",
  },
  backup: {
    title: "Backups",
    description: "Recovery snapshots and restore points for chat sessions.",
  },
  usage: {
    title: "Usage",
    description: "Token usage and estimated cost across sessions.",
  },
  developer: {
    title: "Developer",
    description: "Debug visibility and advanced workspace options.",
  },
  featureFlags: {
    title: "Feature flags",
    description: "Enable or disable experimental capabilities.",
  },
  updates: {
    title: "Updates",
    description: "App version and restart-based updates.",
  },
};

export function getSettingsGroups(remoteAccessAvailable: boolean): Array<{
  label: string;
  pages: SettingsPageDefinition[];
}> {
  return [
    {
      label: "Models & tools",
      pages: [
        { id: "providers", label: "Providers", render: () => <ProvidersPage /> },
        { id: "mcp", label: "MCP servers", render: () => <McpServersPage /> },
      ],
    },
    {
      label: "Workspace",
      pages: [
        { id: "workspaces", label: "General", render: () => <WorkspacesPage /> },
        { id: "memory", label: "Memory", render: () => <MemoryPage /> },
        ...(remoteAccessAvailable
          ? [{ id: "remoteAccess", label: "Remote access", render: () => <RemoteAccessPage /> } satisfies SettingsPageDefinition]
          : []),
      ],
    },
    {
      label: "Data",
      pages: [
        { id: "backup", label: "Backups", render: () => <BackupPage /> },
        { id: "usage", label: "Usage", render: () => <UsagePage /> },
      ],
    },
    {
      label: "Advanced",
      pages: [
        { id: "featureFlags", label: "Feature flags", render: () => <FeatureFlagsPage /> },
        { id: "developer", label: "Developer", render: () => <DeveloperPage /> },
        { id: "updates", label: "Updates", render: () => <UpdatesPage /> },
      ],
    },
  ];
}

function SettingsNavigation({
  activePage,
  onSelectPage,
  onBack,
  settingsGroups,
}: {
  activePage: SettingsPageId;
  onSelectPage: (page: SettingsPageId) => void;
  onBack: () => void;
  settingsGroups: Array<{
    label: string;
    pages: SettingsPageDefinition[];
  }>;
}) {
  const currentWorkspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId));
  const perWorkspaceSettings = useAppStore((s) => s.perWorkspaceSettings);

  return (
    <aside className="settings-shell__nav app-left-sidebar-pane flex min-h-0 min-w-0 flex-col border-r border-border/50 max-[860px]:border-r-0 max-[860px]:border-b">
      <div className="shrink-0 border-b border-border/50 px-3 py-3">
        <Button
          className="settings-shell__back-button h-9 w-full justify-start rounded-md border border-border/50 bg-foreground/[0.03] px-2.5 text-[13px] font-medium"
          variant="ghost"
          type="button"
          onClick={onBack}
        >
          <ArrowLeftIcon className="mr-2 h-4 w-4 shrink-0 opacity-70" />
          Back
        </Button>
        {perWorkspaceSettings && currentWorkspace && (
          <div className="mt-2 truncate px-1 text-[11px] text-foreground/68" title={currentWorkspace.name}>
            {currentWorkspace.name}
          </div>
        )}
      </div>

      <nav
        className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2 pb-4"
        aria-label="Settings sections"
      >
        <div className="flex flex-col gap-3 max-[860px]:flex-row max-[860px]:flex-wrap max-[860px]:gap-x-4 max-[860px]:gap-y-3">
          {settingsGroups.map((group) => (
            <div key={group.label} className="flex min-w-0 flex-col">
              <div className="mb-0.5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-foreground/72">
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.pages.map((page) => (
                  <button
                    key={page.id}
                    className={cn(
                      "settings-shell__nav-button flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                      activePage === page.id
                        ? "bg-foreground/[0.08] font-medium text-foreground ring-1 ring-border/40"
                        : "font-normal text-foreground/78 hover:bg-foreground/[0.05] hover:text-foreground",
                    )}
                    type="button"
                    onClick={() => onSelectPage(page.id)}
                  >
                    {page.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </aside>
  );
}

export function SettingsShell() {
  const desktopFeatureFlags = useAppStore((s) => s.desktopFeatureFlags);
  const remoteAccessAvailable = desktopFeatureFlags.remoteAccess === true;
  const settingsPage = useAppStore((s) => s.settingsPage);
  const setSettingsPage = useAppStore((s) => s.setSettingsPage);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const settingsGroups = getSettingsGroups(remoteAccessAvailable);
  const settingsPages = settingsGroups.flatMap((group) => group.pages);
  const activePage = settingsPages.find((page) => page.id === settingsPage) ?? settingsPages[0];
  const meta = SETTINGS_PAGE_META[activePage.id];

  const [pageChrome, setPageChromeState] = useState<SettingsChromeState>({});
  const handleChromeChange = useCallback((next: SettingsChromeState) => {
    setPageChromeState(next);
  }, []);

  const isBackupPage = activePage.id === "backup";

  return (
    <div
      className="settings-shell relative grid h-full min-h-0 min-w-0 bg-transparent"
      style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
    >
      <div className="settings-shell__drag-zone absolute inset-x-0 top-0" aria-hidden="true" />
      <SettingsNavigation
        activePage={settingsPage}
        onSelectPage={setSettingsPage}
        onBack={closeSettings}
        settingsGroups={settingsGroups}
      />

      <main className="settings-shell__main app-main-content flex min-h-0 min-w-0 flex-col">
        <SettingsChromeProvider onChromeChange={handleChromeChange}>
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              isBackupPage ? "overflow-hidden" : "",
            )}
          >
            <header
              className={cn(
                "settings-shell__page-header shrink-0 px-5 py-4 backdrop-blur-sm max-[860px]:px-4",
                isBackupPage ? "" : "sticky top-0 z-10",
              )}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <h1 className="text-xl font-semibold tracking-tight text-foreground">
                    {meta.title}
                  </h1>
                  <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                    {meta.description}
                  </p>
                </div>
                {pageChrome.headerActions ? (
                  <div className="settings-shell__header-actions flex shrink-0 flex-wrap items-center justify-end gap-2 sm:pt-0.5">
                    {pageChrome.headerActions}
                  </div>
                ) : null}
              </div>
            </header>

            <div
              className={cn(
                "settings-shell__scroll min-h-0 min-w-0 flex-1",
                isBackupPage ? "flex min-h-0 flex-col overflow-hidden" : "overflow-y-auto",
              )}
            >
              <div
                className={cn(
                  "settings-shell__content w-full",
                  isBackupPage
                    ? "flex min-h-0 flex-1 flex-col p-0"
                    : "max-[860px]:p-4 min-[861px]:px-5 min-[861px]:pb-6 min-[861px]:pt-4",
                )}
              >
                <div
                  key={activePage.id}
                  className={cn(
                    "animate-in fade-in duration-150",
                    isBackupPage ? "flex min-h-0 flex-1 flex-col" : "",
                  )}
                >
                  {activePage.render()}
                </div>
              </div>
            </div>
          </div>
        </SettingsChromeProvider>
      </main>
    </div>
  );
}
