import type { ReactNode } from "react";

import { ProvidersPage } from "./pages/ProvidersPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";

import { useAppStore } from "../../app/store";
import type { SettingsPageId } from "../../app/types";

type SettingsPageDefinition = {
  id: SettingsPageId;
  label: string;
  render: () => ReactNode;
};

const SETTINGS_PAGES: SettingsPageDefinition[] = [
  { id: "providers", label: "Providers", render: () => <ProvidersPage /> },
  { id: "workspaces", label: "Workspaces", render: () => <WorkspacesPage /> },
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
    <aside className="settingsNav">
      <button className="settingsBackButton" type="button" onClick={onBack}>
        Back to app
      </button>

      <div className="settingsNavList">
        {SETTINGS_PAGES.map((page) => (
          <button
            key={page.id}
            className="settingsNavItem"
            data-active={activePage === page.id}
            type="button"
            onClick={() => onSelectPage(page.id)}
          >
            {page.label}
          </button>
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
    <div className="settingsApp">
      <SettingsNavigation activePage={settingsPage} onSelectPage={setSettingsPage} onBack={closeSettings} />

      <main className="settingsPage">
        <div className="settingsContent">{activePage.render()}</div>
      </main>
    </div>
  );
}
