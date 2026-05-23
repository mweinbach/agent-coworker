import {
  ActivityIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  BotIcon,
  FlaskConicalIcon,
  HistoryIcon,
  type LucideIcon,
  MonitorIcon,
  RefreshCcwIcon,
  SlidersHorizontalIcon,
  UserRoundCogIcon,
  WifiIcon,
  WrenchIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useState } from "react";

import { includeDevelopmentSettings } from "../../app/settingsPageAvailability";
import { useAppStore } from "../../app/store";
import { isOneOffChatWorkspace, type SettingsPageId } from "../../app/types";
import { isPackagedDesktopApp } from "../../lib/desktopCommands";
import { type DesktopPlatformInfo, getDesktopPlatformInfo } from "../../lib/desktopPlatform";
import { cn } from "../../lib/utils";
import { BackupPage } from "./pages/BackupPage";
import { DesktopPage } from "./pages/DesktopPage";
import { DeveloperPage } from "./pages/DeveloperPage";
import { FeatureFlagsPage } from "./pages/FeatureFlagsPage";
import { RemoteAccessPage } from "./pages/RemoteAccessPage";
import {
  ChatsSettingsPage,
  DefaultsSettingsPage,
  ModelsSettingsPage,
  ProfileMemorySettingsPage,
  ToolAccessSettingsPage,
} from "./pages/SettingsIntentPages";
import { UpdatesPage } from "./pages/UpdatesPage";
import { UsagePage } from "./pages/UsagePage";
import { SettingsChromeProvider, type SettingsChromeState } from "./SettingsChromeContext";

type SettingsPageDefinition = {
  id: SettingsPageId;
  label: string;
  icon: LucideIcon;
  render: () => ReactNode;
};

const SETTINGS_PAGE_META: Record<SettingsPageId, { title: string; description: string }> = {
  models: {
    title: "Models",
    description: "Provider health, model defaults, and subagent routing.",
  },
  toolAccess: {
    title: "Tool Access",
    description: "External services, MCP servers, and local search tools Cowork can use.",
  },
  desktop: {
    title: "Desktop",
    description: "Menu bar, tray, and quick chat controls for the desktop app.",
  },
  defaults: {
    title: "Defaults",
    description: "Defaults for models, tools, and behavior in this project.",
  },
  profileMemory: {
    title: "Profile & Memory",
    description: "How Cowork should understand you and what it should remember.",
  },
  remoteAccess: {
    title: "Remote access",
    description: "Pair a phone to this workspace over the relay when the app is open.",
  },
  backup: {
    title: "Backups",
    description: "Recovery snapshots and restore points for chat sessions.",
  },
  chats: {
    title: "Chats",
    description: "Archived chat history, restore actions, and retention.",
  },
  usage: {
    title: "Usage",
    description: "Token usage and estimated cost across sessions.",
  },
  experiments: {
    title: "Experiments",
    description: "Enable or disable experimental capabilities.",
  },
  diagnostics: {
    title: "Diagnostics",
    description: "Debug visibility, runtime checks, and advanced output handling.",
  },
  updates: {
    title: "Updates",
    description: "App version and restart-based updates.",
  },
  providers: {
    title: "Models",
    description: "Provider health, model defaults, and subagent routing.",
  },
  openAiNativeConnectors: {
    title: "Tool Access",
    description: "External services, MCP servers, and local search tools Cowork can use.",
  },
  mcp: {
    title: "Tool Access",
    description: "External services, MCP servers, and local search tools Cowork can use.",
  },
  workspaces: {
    title: "Defaults",
    description: "Defaults for models, tools, and behavior in this project.",
  },
  memory: {
    title: "Profile & Memory",
    description: "How Cowork should understand you and what it should remember.",
  },
  featureFlags: {
    title: "Experiments",
    description: "Enable or disable experimental capabilities.",
  },
  developer: {
    title: "Diagnostics",
    description: "Debug visibility, runtime checks, and advanced output handling.",
  },
  archivedChats: {
    title: "Chats",
    description: "Archived chat history, restore actions, and retention.",
  },
};

export function getSettingsGroups(
  remoteAccessAvailable: boolean,
  opts: { includeDevelopmentPages?: boolean } = {},
): Array<{
  label: string;
  pages: SettingsPageDefinition[];
}> {
  const includeDevelopmentPages = opts.includeDevelopmentPages ?? true;
  return [
    {
      label: "Models & tools",
      pages: [
        { id: "models", label: "Models", icon: BotIcon, render: () => <ModelsSettingsPage /> },
        {
          id: "toolAccess",
          label: "Tool Access",
          icon: WrenchIcon,
          render: () => <ToolAccessSettingsPage />,
        },
      ],
    },
    {
      label: "Workspace",
      pages: [
        {
          id: "defaults",
          label: "Defaults",
          icon: SlidersHorizontalIcon,
          render: () => <DefaultsSettingsPage />,
        },
        {
          id: "profileMemory",
          label: "Profile & Memory",
          icon: UserRoundCogIcon,
          render: () => <ProfileMemorySettingsPage />,
        },
        ...(remoteAccessAvailable
          ? [
              {
                id: "remoteAccess",
                label: "Remote access",
                icon: WifiIcon,
                render: () => <RemoteAccessPage />,
              } satisfies SettingsPageDefinition,
            ]
          : []),
      ],
    },
    {
      label: "History & Data",
      pages: [
        { id: "backup", label: "Backups", icon: ArchiveRestoreIcon, render: () => <BackupPage /> },
        { id: "chats", label: "Chats", icon: HistoryIcon, render: () => <ChatsSettingsPage /> },
        { id: "usage", label: "Usage", icon: BarChart3Icon, render: () => <UsagePage /> },
      ],
    },
    {
      label: "App",
      pages: [
        { id: "desktop", label: "Desktop", icon: MonitorIcon, render: () => <DesktopPage /> },
        { id: "updates", label: "Updates", icon: RefreshCcwIcon, render: () => <UpdatesPage /> },
      ],
    },
    {
      label: "Advanced",
      pages: [
        ...(includeDevelopmentPages
          ? [
              {
                id: "experiments",
                label: "Experiments",
                icon: FlaskConicalIcon,
                render: () => <FeatureFlagsPage />,
              } satisfies SettingsPageDefinition,
            ]
          : []),
        {
          id: "diagnostics",
          label: "Diagnostics",
          icon: ActivityIcon,
          render: () => <DeveloperPage />,
        },
      ],
    },
  ];
}

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
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId && !isOneOffChatWorkspace(w)),
  );
  const perWorkspaceSettings = useAppStore((s) => s.perWorkspaceSettings);

  return (
    <aside className="settings-shell__nav app-left-sidebar-pane flex min-h-0 min-w-0 flex-col border-r border-border/50 max-[860px]:border-r-0 max-[860px]:border-b">
      <div className="shrink-0 settings-shell__nav-header border-b border-border/50">
        <div className="settings-shell__nav-titleband">
          <div className="settings-shell__nav-titleband-drag-zone" aria-hidden="true" />
          <div className="settings-shell__nav-titleband-row px-3 flex items-center">
            <button
              className="settings-shell__back-button flex h-9 w-full items-center justify-start gap-2 rounded-md px-2.5 text-left text-[13px] font-medium text-foreground/72 transition-all duration-150 hover:bg-foreground/[0.045] hover:text-foreground"
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
            className="truncate px-4 pb-3 text-[11px] text-foreground/68"
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
        <div className="flex flex-col gap-3 max-[860px]:flex-row max-[860px]:flex-wrap max-[860px]:gap-x-4 max-[860px]:gap-y-3">
          {settingsGroups.map((group) => (
            <div key={group.label} className="flex min-w-0 flex-col">
              <div className="mb-1 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/58">
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.pages.map((page) => {
                  const Icon = page.icon;
                  return (
                    <button
                      key={page.id}
                      className={cn(
                        "settings-shell__nav-button flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-all duration-150",
                        activePage === page.id
                          ? "settings-shell__nav-button--active font-semibold text-foreground"
                          : "font-medium text-foreground/72 hover:bg-foreground/[0.045] hover:text-foreground",
                      )}
                      type="button"
                      onClick={() => onSelectPage(page.id)}
                    >
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          activePage === page.id ? "text-foreground" : "text-muted-foreground",
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
    </aside>
  );
}

export function SettingsShell() {
  const desktopFeatureFlags = useAppStore((s) => s.desktopFeatureFlags);
  const remoteAccessAvailable = desktopFeatureFlags.remoteAccess === true;
  const packaged = useAppStore((s) => s.updateState.packaged);
  const settingsPage = useAppStore((s) => s.settingsPage);
  const setSettingsPage = useAppStore((s) => s.setSettingsPage);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
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
  const platformInfo = getDesktopPlatformInfo();
  const settingsDragZoneStyle = getSettingsDragZoneStyle(sidebarWidth, platformInfo);

  const isBackupPage = activePage.id === "backup";

  return (
    <div
      className="settings-shell relative grid h-full min-h-0 min-w-0 bg-transparent"
      style={{ "--settings-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
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
      <SettingsNavigation
        activePage={activePage.id}
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
                "settings-shell__page-header shrink-0 px-5 backdrop-blur-sm max-[860px]:px-4",
                isBackupPage ? "pb-3 pt-4" : "sticky top-0 z-10 py-4",
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

            <div className="settings-shell__scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
              <div
                className={cn(
                  "settings-shell__content w-full",
                  isBackupPage
                    ? "flex min-h-0 flex-1 flex-col max-[860px]:px-4 max-[860px]:pb-4 min-[861px]:px-5 min-[861px]:pb-6"
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
