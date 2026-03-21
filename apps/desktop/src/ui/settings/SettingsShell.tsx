import type { ReactNode } from "react";

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

type SettingsPageDefinition = {
  id: SettingsPageId;
  label: string;
  render: () => ReactNode;
};

const SETTINGS_GROUPS = [
  {
    label: "Models & Tools",
    pages: [
      { id: "providers", label: "Providers", render: () => <ProvidersPage /> },
      { id: "mcp", label: "Integrations", render: () => <McpServersPage /> },
    ] as SettingsPageDefinition[],
  },
  {
    label: "Workspace",
    pages: [
      { id: "workspaces", label: "General", render: () => <WorkspacesPage /> },
      { id: "memory", label: "Memory", render: () => <MemoryPage /> },
    ] as SettingsPageDefinition[],
  },
  {
    label: "Recovery & Data",
    pages: [
      { id: "backup", label: "Backup", render: () => <BackupPage /> },
      { id: "usage", label: "Usage", render: () => <UsagePage /> },
    ] as SettingsPageDefinition[],
  },
  {
    label: "Advanced",
    pages: [
      { id: "developer", label: "Developer", render: () => <DeveloperPage /> },
      { id: "updates", label: "Updates", render: () => <UpdatesPage /> },
    ] as SettingsPageDefinition[],
  },
];

const SETTINGS_PAGES: SettingsPageDefinition[] = SETTINGS_GROUPS.flatMap(g => g.pages);

function SettingsNavigation({
  activePage,
  onSelectPage,
  onBack,
}: {
  activePage: SettingsPageId;
  onSelectPage: (page: SettingsPageId) => void;
  onBack: () => void;
}) {
  const currentWorkspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId));
  const perWorkspaceSettings = useAppStore((s) => s.perWorkspaceSettings);

  return (
    <aside className="settings-shell__nav app-left-sidebar-pane flex min-h-0 flex-col border-r border-border/70 max-[960px]:border-r-0 max-[960px]:border-b">
      <div className="border-b border-border/80 px-3.5 py-4 flex flex-col gap-2">
        <Button
          className="settings-shell__back-button sidebar-lift h-10 w-full justify-start rounded-xl border border-border/75 bg-foreground/[0.035] px-3 text-[14px] font-medium text-foreground/86 hover:bg-foreground/[0.055] hover:text-foreground"
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

      <div className="flex-1 overflow-y-auto px-3.5 py-4 flex flex-col gap-6 max-[960px]:flex-row max-[960px]:flex-wrap">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <h4 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/88">
              {group.label}
            </h4>
            <div className="flex flex-col gap-0.5">
              {group.pages.map((page) => (
                <Button
                  key={page.id}
                  variant="ghost"
                  className={cn(
                    "settings-shell__nav-button sidebar-lift h-9 justify-start rounded-xl px-3 text-[14px] font-medium tracking-[-0.015em]",
                    activePage === page.id
                      ? "bg-foreground/[0.055] text-foreground"
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
  const settingsPage = useAppStore((s) => s.settingsPage);
  const setSettingsPage = useAppStore((s) => s.setSettingsPage);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const activePage = SETTINGS_PAGES.find((page) => page.id === settingsPage) ?? SETTINGS_PAGES[0];

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
      />

      <main className="settings-shell__main app-main-content min-h-0 overflow-auto">
        <div
          className={cn(
            "settings-shell__content w-full max-[960px]:p-4",
            activePage.id === "backup" ? "h-full p-0" : "p-6 lg:p-7"
          )}
        >
          <div key={activePage.id} className="animate-in fade-in slide-in-from-bottom-4 duration-300 ease-out h-full">
            {activePage.render()}
          </div>
        </div>
      </main>
    </div>
  );
}
