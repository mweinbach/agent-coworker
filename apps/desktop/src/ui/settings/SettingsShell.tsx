import type { ReactNode } from "react";

import { ArrowLeftIcon } from "lucide-react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { isRemoteAccessEnabled } from "../../lib/desktopCommands";
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

type SettingsPageDefinition = {
  id: SettingsPageId;
  label: string;
  render: () => ReactNode;
};

export function getSettingsGroups(remoteAccessAvailable: boolean): Array<{
  label: string;
  pages: SettingsPageDefinition[];
}> {
  return [
    {
      label: "Models & Tools",
      pages: [
        { id: "providers", label: "Providers", render: () => <ProvidersPage /> },
        { id: "mcp", label: "Integrations", render: () => <McpServersPage /> },
      ],
    },
    {
      label: "Workspace",
      pages: [
        { id: "workspaces", label: "General", render: () => <WorkspacesPage /> },
        { id: "memory", label: "Memory", render: () => <MemoryPage /> },
        ...(remoteAccessAvailable
          ? [{ id: "remoteAccess", label: "Remote Access", render: () => <RemoteAccessPage /> } satisfies SettingsPageDefinition]
          : []),
      ],
    },
    {
      label: "Recovery & Data",
      pages: [
        { id: "backup", label: "Backup", render: () => <BackupPage /> },
        { id: "usage", label: "Usage", render: () => <UsagePage /> },
      ],
    },
    {
      label: "Advanced",
      pages: [
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
    <aside className="settings-shell__nav app-left-sidebar-pane flex min-h-0 flex-col border-r border-border/60 bg-gradient-to-b from-muted/12 to-muted/[0.04] max-[960px]:border-r-0 max-[960px]:border-b max-[960px]:bg-gradient-to-r max-[960px]:from-muted/10 max-[960px]:to-transparent">
      <div className="border-b border-border/70 px-3 py-3 flex flex-col gap-2">
        <Button
          className="settings-shell__back-button sidebar-lift h-9 w-full justify-start rounded-lg border border-border/70 bg-foreground/[0.03] px-3 text-[13px] font-medium text-foreground/86 hover:bg-foreground/[0.05] hover:text-foreground"
          variant="ghost"
          type="button"
          onClick={onBack}
        >
          <ArrowLeftIcon className="h-4 w-4 mr-2" />
          Back to app
        </Button>
        {perWorkspaceSettings && currentWorkspace && (
          <div className="mt-1 px-1 text-xs font-medium text-muted-foreground truncate">
            {currentWorkspace.name}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3.5 pb-4 flex flex-col gap-5 max-[960px]:flex-row max-[960px]:flex-wrap">
        {settingsGroups.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <h4 className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
              {group.label}
            </h4>
            <div className="flex flex-col gap-0.5">
              {group.pages.map((page) => (
                <Button
                  key={page.id}
                  variant="ghost"
                  className={cn(
                    "settings-shell__nav-button sidebar-lift h-8 justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em]",
                    activePage === page.id
                      ? "bg-foreground/[0.07] text-foreground shadow-sm ring-1 ring-border/45"
                      : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
                  )}
                  type="button"
                  onClick={() => onSelectPage(page.id)}
                >
                  {page.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function SettingsShell() {
  const remoteAccessAvailable = isRemoteAccessEnabled();
  const settingsPage = useAppStore((s) => s.settingsPage);
  const setSettingsPage = useAppStore((s) => s.setSettingsPage);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const settingsGroups = getSettingsGroups(remoteAccessAvailable);
  const settingsPages = settingsGroups.flatMap((group) => group.pages);
  const activePage = settingsPages.find((page) => page.id === settingsPage) ?? settingsPages[0];

  return (
    <div
      className="settings-shell relative grid h-full min-h-0 min-w-0 bg-transparent"
      style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
    >
      <div className="settings-shell__drag-zone" aria-hidden="true" />
      <SettingsNavigation
        activePage={settingsPage}
        onSelectPage={setSettingsPage}
        onBack={closeSettings}
        settingsGroups={settingsGroups}
      />

      <main className="settings-shell__main app-main-content min-h-0 overflow-auto">
        <div
          className={cn(
            "settings-shell__content w-full",
            // Narrow: even padding. Wide: flush to the nav divider on the left; keep right/top/bottom inset.
            activePage.id === "backup"
              ? "h-full p-0"
              : "max-[960px]:p-4 min-[961px]:pl-3 min-[961px]:py-5 min-[961px]:pr-5 lg:py-6 lg:pr-6",
          )}
        >
          <div key={activePage.id} className="animate-in fade-in slide-in-from-bottom-2 duration-200 ease-out h-full">
            {activePage.render()}
          </div>
        </div>
      </main>
    </div>
  );
}
