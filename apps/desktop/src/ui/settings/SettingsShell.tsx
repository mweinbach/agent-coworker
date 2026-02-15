import { ProvidersPage } from "./pages/ProvidersPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";

import { useAppStore } from "../../app/store";
import type { SettingsPageId } from "../../app/types";

const NAV_ITEMS: Array<{ id: SettingsPageId; label: string }> = [
  { id: "providers", label: "Providers" },
  { id: "workspaces", label: "Workspaces" },
];

export function SettingsShell() {
  const settingsPage = useAppStore((s) => s.settingsPage);
  const setSettingsPage = useAppStore((s) => s.setSettingsPage);
  const closeSettings = useAppStore((s) => s.closeSettings);

  return (
    <div className="settingsApp">
      <aside className="settingsNav">
        <button className="settingsBackButton" type="button" onClick={closeSettings}>
          Back to app
        </button>

        <div className="settingsNavList">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className="settingsNavItem"
              data-active={settingsPage === item.id}
              type="button"
              onClick={() => setSettingsPage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </aside>

      <main className="settingsPage">
        <div className="settingsContent">
          {settingsPage === "providers" ? (
            <ProvidersPage />
          ) : (
            <WorkspacesPage />
          )}
        </div>
      </main>
    </div>
  );
}