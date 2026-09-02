import { Outlet, useRouterState } from "@tanstack/react-router";
import { normalizeKnownSettingsPageId } from "../../app/settingsNavigation";
import { useAppStore } from "../../app/store";
import { SettingsContent } from "./SettingsContent";

export function SettingsScreen() {
  const page = useRouterState({
    select: (state) => normalizeKnownSettingsPageId(state.matches.at(-1)?.pathname.split("/")[2]),
  });
  const init = useAppStore((state) => state.init);
  const ready = useAppStore((state) => state.ready);
  const startupError = useAppStore((state) => state.startupError);
  return (
    <div className="app-shell app-shell--settings flex h-full min-h-0 flex-col text-foreground">
      <div className="app-window-drag-strip" aria-hidden="true" />
      <div className="min-h-0 flex-1">
        <SettingsContent init={init} ready={ready} startupError={startupError} page={page}>
          <Outlet />
        </SettingsContent>
      </div>
    </div>
  );
}
