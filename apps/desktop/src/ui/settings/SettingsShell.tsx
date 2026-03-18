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
    <aside className="settings-shell__nav flex min-h-0 flex-col border-r border-border/80 bg-sidebar max-[960px]:border-r-0 max-[960px]:border-b">
      <div className="p-4 border-b border-border/80 flex flex-col gap-2">
        <Button className="settings-shell__back-button justify-start w-full" variant="outline" type="button" onClick={onBack}>
          <ArrowLeftIcon className="h-4 w-4 mr-2" />
          Back to app
        </Button>
        {perWorkspaceSettings && currentWorkspace && (
          <div className="text-xs text-muted-foreground mt-2 px-1 font-medium truncate">
            {currentWorkspace.name}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6 max-[960px]:flex-row max-[960px]:flex-wrap">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold text-muted-foreground px-2 mb-1 uppercase tracking-wider">{group.label}</h4>
            <div className="flex flex-col gap-0.5">
              {group.pages.map((page) => (
                <Button
                  key={page.id}
                  variant={activePage === page.id ? "secondary" : "ghost"}
                  className={cn("justify-start h-8 px-3 text-sm font-medium", activePage === page.id ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
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
  const activePage = SETTINGS_PAGES.find((page) => page.id === settingsPage) ?? SETTINGS_PAGES[0];

  return (
    <div className="settings-shell relative grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)] bg-background max-[960px]:grid-cols-1">
      <div className="settings-shell__drag-zone" aria-hidden="true" />
      <SettingsNavigation activePage={settingsPage} onSelectPage={setSettingsPage} onBack={closeSettings} />

      <main className="settings-shell__main min-h-0 overflow-auto bg-muted/10">
        <div
          className={cn(
            "settings-shell__content w-full max-[960px]:p-4",
            activePage.id === "backup" ? "h-full p-0" : "mx-auto max-w-5xl p-6"
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
