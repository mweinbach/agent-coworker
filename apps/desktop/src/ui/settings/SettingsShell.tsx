import type { ReactNode } from "react";

import { ArrowLeftIcon } from "lucide-react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import type { SettingsPageId } from "../../app/types";
import { ProvidersPage } from "./pages/ProvidersPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { DeveloperPage } from "./pages/DeveloperPage";

type SettingsPageDefinition = {
  id: SettingsPageId;
  label: string;
  render: () => ReactNode;
};

const SETTINGS_PAGES: SettingsPageDefinition[] = [
  { id: "providers", label: "Providers", render: () => <ProvidersPage /> },
  { id: "workspaces", label: "Workspaces", render: () => <WorkspacesPage /> },
  { id: "developer", label: "Developer", render: () => <DeveloperPage /> },
];

function SettingsNavigation({
  activePage,
  onSelectPage,
  onBack,
}: {
  activePage: SettingsPageId;
  onSelectPage: (page: SettingsPageId) => void;
  onBack: () => void;
}) {
  return (
    <aside className="settings-shell__nav flex min-h-0 flex-col gap-3 border-r border-border/80 bg-sidebar p-4 max-[960px]:border-r-0 max-[960px]:border-b">
      <Button className="settings-shell__back-button justify-start" variant="outline" type="button" onClick={onBack}>
        <ArrowLeftIcon className="h-4 w-4" />
        Back to app
      </Button>

      <div className="flex flex-col gap-1 max-[960px]:flex-row max-[960px]:flex-wrap">
        {SETTINGS_PAGES.map((page) => (
          <Button
            key={page.id}
            variant={activePage === page.id ? "secondary" : "ghost"}
            className={cn("justify-start", activePage === page.id ? "border border-border/70" : "")}
            type="button"
            onClick={() => onSelectPage(page.id)}
          >
            {page.label}
          </Button>
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

      <main className="settings-shell__main min-h-0 overflow-auto bg-gradient-to-b from-panel to-background">
        <div className="settings-shell__content mx-auto w-full max-w-5xl p-6 max-[960px]:p-4">{activePage.render()}</div>
      </main>
    </div>
  );
}
