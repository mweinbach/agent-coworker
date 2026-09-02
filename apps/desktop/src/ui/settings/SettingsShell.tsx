import { ArrowLeftIcon, PanelLeftIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigationSnapshot } from "../../app/navigation";
import { includeDevelopmentSettings } from "../../app/settingsPageAvailability";
import { useAppStore } from "../../app/store";
import type { SettingsPageId } from "../../app/types";
import { Button } from "../../components/ui/button";
import { isPackagedDesktopApp } from "../../lib/desktopCommands";
import { type DesktopPlatformInfo, getDesktopPlatformInfo } from "../../lib/desktopPlatform";
import { onDesktopRailCommand } from "../../lib/desktopRailCommands";
import { useAdaptiveLayout } from "../../lib/useAdaptiveLayout";
import { cn } from "../../lib/utils";
import { InlineErrorBoundary } from "../CrashReportingErrorBoundary";
import { AdaptiveRailSurface } from "../layout/AdaptiveRailSurface";
import { SettingsChromeProvider, type SettingsChromeState } from "./SettingsChromeContext";
import {
  getSettingsGroups,
  SETTINGS_PAGE_META,
  type SettingsPageDefinition,
} from "./settingsPages";

export function getSettingsDragZoneStyle(
  sidebarWidth: number,
  platformInfo: DesktopPlatformInfo,
): CSSProperties | undefined {
  if (platformInfo.sidebarTitlebandMode === "native") {
    return { "--settings-sidebar-width": `${sidebarWidth}px` } as CSSProperties;
  }
  return undefined;
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
  const currentWorkspace = useAppStore((s) =>
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId),
  );
  const perWorkspaceSettings = useAppStore((s) => s.perWorkspaceSettings);

  return (
    <>
      <div className="shrink-0 settings-shell__nav-header border-b app-border-subtle">
        <div className="settings-shell__nav-titleband">
          <div className="settings-shell__nav-titleband-drag-zone" aria-hidden="true" />
          <div className="settings-shell__nav-titleband-row px-3 flex items-center">
            <button
              className="settings-shell__back-button flex h-9 w-full items-center justify-start gap-2 rounded-md px-2.5 text-left app-type-body font-medium app-text-secondary transition-colors duration-150 hover:app-hover-wash hover:text-foreground"
              type="button"
              onClick={onBack}
            >
              <ArrowLeftIcon className="h-4 w-4 shrink-0" />
              Back
            </button>
          </div>
        </div>
        {perWorkspaceSettings && currentWorkspace ? (
          <div
            className="app-type-caption truncate px-4 pb-3 app-text-secondary"
            title={currentWorkspace.name}
          >
            {currentWorkspace.name}
          </div>
        ) : null}
      </div>

      <nav
        className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2 pb-4"
        aria-label="Settings sections"
      >
        <div className="flex flex-col gap-3">
          {settingsGroups.map((group) => (
            <div key={group.label} className="flex min-w-0 flex-col">
              <div className="app-type-label mb-1 px-2 py-1.5 uppercase tracking-[0.08em] app-text-muted">
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.pages.map((page) => {
                  const Icon = page.icon;
                  return (
                    <button
                      key={page.id}
                      aria-current={activePage === page.id ? "page" : undefined}
                      className={cn(
                        "settings-shell__nav-button flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left app-type-body transition-colors duration-150",
                        activePage === page.id
                          ? "settings-shell__nav-button--active font-semibold text-foreground"
                          : "font-medium app-text-secondary hover:app-hover-wash hover:text-foreground",
                      )}
                      type="button"
                      onClick={() => onSelectPage(page.id)}
                    >
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          activePage === page.id
                            ? "text-[var(--text-settings-nav-active-icon)]"
                            : "text-muted-foreground",
                        )}
                      />
                      <span className="min-w-0 truncate">{page.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}

export function SettingsShell({
  children,
  page,
}: {
  children?: ReactNode;
  page?: SettingsPageId;
} = {}) {
  const desktopFeatureFlags = useAppStore((s) => s.desktopFeatureFlags);
  const remoteAccessAvailable = desktopFeatureFlags.remoteAccess === true;
  const packaged = useAppStore((s) => s.updateState.packaged);
  const currentPage = useNavigationSnapshot().settingsPage;
  const settingsPage = page ?? currentPage;
  const setSettingsPage = useAppStore((s) => s.setSettingsPage);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const adaptiveLayout = useAdaptiveLayout({
    contextSidebarCollapsed: true,
    hasContextSidebar: false,
    leftSidebarWidth: sidebarWidth,
    rightSidebarMaximumWidth: 0,
    rightSidebarMinimumWidth: 0,
    rightSidebarWidth: 0,
    sidebarCollapsed: false,
  });
  const effectiveSidebarWidth = adaptiveLayout.leftOverlay
    ? Math.max(160, Math.min(440, sidebarWidth))
    : adaptiveLayout.leftWidth;
  const navigationActive =
    adaptiveLayout.leftInline || (adaptiveLayout.leftOverlay && navigationOpen);
  useEffect(
    () =>
      onDesktopRailCommand((command) => {
        if (command !== "toggle-sidebar") return;
        if (adaptiveLayout.leftOverlay) {
          setNavigationOpen((open) => !open);
        }
      }),
    [adaptiveLayout.leftOverlay],
  );
  const settingsGroups = getSettingsGroups(remoteAccessAvailable, {
    includeDevelopmentPages: includeDevelopmentSettings(packaged || isPackagedDesktopApp()),
  });
  const settingsPages = settingsGroups.flatMap((group) => group.pages);
  const activePage = settingsPages.find((page) => page.id === settingsPage) ?? settingsPages[0];
  const meta = SETTINGS_PAGE_META[activePage.id];

  const [pageChrome, setPageChromeState] = useState<SettingsChromeState>({});
  const handleChromeChange = useCallback((next: SettingsChromeState) => {
    setPageChromeState(next);
  }, []);
  const handleSelectPage = useCallback(
    (page: SettingsPageId) => {
      setSettingsPage(page);
      if (adaptiveLayout.leftOverlay) {
        setNavigationOpen(false);
      }
    },
    [adaptiveLayout.leftOverlay, setSettingsPage],
  );
  const platformInfo = getDesktopPlatformInfo();
  const settingsDragZoneStyle = getSettingsDragZoneStyle(
    adaptiveLayout.leftInline ? adaptiveLayout.leftWidth : 0,
    platformInfo,
  );
  const isMacos = platformInfo.platform === "macos";

  const isBackupPage = activePage.id === "backup";
  const navigationToggle = adaptiveLayout.leftOverlay ? (
    <Button
      aria-expanded={navigationOpen}
      aria-label={navigationOpen ? "Close settings navigation" : "Open settings navigation"}
      className="app-native-no-drag shrink-0"
      onClick={() => setNavigationOpen((open) => !open)}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      <PanelLeftIcon aria-hidden="true" />
    </Button>
  ) : null;

  return (
    <div
      className="settings-shell relative grid h-full min-h-0 min-w-0 bg-transparent"
      data-layout-tier={adaptiveLayout.tier}
      style={
        {
          "--settings-sidebar-width": `${effectiveSidebarWidth}px`,
          gridTemplateColumns: adaptiveLayout.leftInline
            ? `${adaptiveLayout.leftWidth}px minmax(0, 1fr)`
            : "minmax(0, 1fr)",
        } as CSSProperties
      }
    >
      {platformInfo.sidebarTitlebandMode === "native" ? (
        <div
          className="settings-shell__titleband-fill absolute inset-x-0 top-0"
          style={settingsDragZoneStyle}
          aria-hidden="true"
        />
      ) : null}
      <div
        className="settings-shell__drag-zone absolute inset-x-0 top-0"
        style={settingsDragZoneStyle}
        aria-hidden="true"
      />
      <AdaptiveRailSurface
        active={navigationActive}
        className="settings-shell__nav app-left-sidebar-pane flex h-full min-h-0 min-w-0 flex-col border-r app-border-subtle"
        label="Settings navigation"
        onClose={() => setNavigationOpen(false)}
        overlay={adaptiveLayout.leftOverlay}
        side="left"
        width={effectiveSidebarWidth}
      >
        <SettingsNavigation
          activePage={activePage.id}
          onSelectPage={handleSelectPage}
          onBack={closeSettings}
          settingsGroups={settingsGroups}
        />
      </AdaptiveRailSurface>

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
                "settings-shell__page-header shrink-0 backdrop-blur-sm",
                isMacos
                  ? isBackupPage
                    ? ""
                    : "sticky top-0 z-10"
                  : cn(
                      "px-5 max-[719px]:px-4",
                      isBackupPage ? "pb-3 pt-4" : "sticky top-0 z-10 py-4",
                    ),
              )}
            >
              {isMacos ? (
                <>
                  <div className="settings-shell__page-titleband">
                    <div className="settings-shell__page-titleband-row flex flex-col gap-3 px-5 max-[719px]:px-4 sm:flex-row sm:items-end sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2">
                        {navigationToggle}
                        <h1 className="min-w-0 text-xl font-semibold tracking-tight text-foreground">
                          {meta.title}
                        </h1>
                      </div>
                      {pageChrome.headerActions ? (
                        <div className="settings-shell__header-actions flex shrink-0 flex-wrap items-center justify-end gap-2">
                          {pageChrome.headerActions}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className={cn(
                      "settings-shell__page-intro px-5 max-[719px]:px-4",
                      isBackupPage ? "pb-3 pt-3" : "pb-4 pt-3",
                    )}
                  >
                    <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                      {meta.description}
                    </p>
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {navigationToggle}
                      <h1 className="min-w-0 text-xl font-semibold tracking-tight text-foreground">
                        {meta.title}
                      </h1>
                    </div>
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
              )}
            </header>

            <div className="settings-shell__scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
              <div
                className={cn(
                  "settings-shell__content w-full",
                  isBackupPage
                    ? "flex min-h-0 flex-1 flex-col max-[719px]:px-4 max-[719px]:pb-4 min-[720px]:px-5 min-[720px]:pb-6"
                    : "max-[719px]:p-4 min-[720px]:px-5 min-[720px]:pb-6 min-[720px]:pt-4",
                )}
              >
                <div
                  data-settings-page={activePage.id}
                  className={cn(isBackupPage ? "flex min-h-0 flex-1 flex-col" : "")}
                >
                  <InlineErrorBoundary
                    key={activePage.id}
                    label="This settings page couldn't be rendered."
                  >
                    {children}
                  </InlineErrorBoundary>
                </div>
              </div>
            </div>
          </div>
        </SettingsChromeProvider>
      </main>
    </div>
  );
}
