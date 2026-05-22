import type { CSSProperties } from "react";
import { memo, useEffect, useMemo, useRef } from "react";

import { resolvePluginCatalogWorkspaceSelection } from "./app/pluginManagement";
import { hasGoogleApiKeyForResearch } from "./app/researchAvailability";
import { useAppStore } from "./app/store";
import { disposeAllJsonRpcState } from "./app/store.helpers";
import { isOneOffChatWorkspace } from "./app/types";
import type { DesktopMenuCommand, SystemAppearance } from "./lib/desktopApi";
import {
  getPlatformChrome,
  getSystemAppearance,
  getUpdateState,
  onMenuCommand,
  onSystemAppearanceChanged,
  onUpdateStateChanged,
  setWindowAppearance,
  showCanvasWindow,
  showNotification,
  showQuickChatWindow,
} from "./lib/desktopCommands";
import { getFilePreviewKind, isCanvasSupportedFile } from "./lib/filePreviewKind";
import { applyPlatformChromeToDocument, syncPlatformChromeCssVars } from "./lib/platformChromeDom";
import { canPopOutQuickChatThread } from "./lib/quickChatPopout";
import { getDesktopWindowMode } from "./lib/windowMode";
import { ASK_SKIP_TOKEN } from "./lib/wsProtocol";
import { Canvas } from "./ui/Canvas";
import { ContextSidebar } from "./ui/ContextSidebar";
import { FilePreviewModal } from "./ui/FilePreviewModal";
import { AppTopBar } from "./ui/layout/AppTopBar";
import { ContextSidebarResizer } from "./ui/layout/ContextSidebarResizer";
import { PrimaryContent } from "./ui/layout/PrimaryContent";
import { SettingsContent } from "./ui/layout/SettingsContent";
import { SidebarResizer } from "./ui/layout/SidebarResizer";
import { MenuBarUtilityShell } from "./ui/menuBar/MenuBarUtilityShell";
import { DesktopOnboarding } from "./ui/onboarding/DesktopOnboarding";
import { PromptModal } from "./ui/PromptModal";
import { QuickChatShell } from "./ui/quickChat/QuickChatShell";
import { Sidebar } from "./ui/Sidebar";

const LeftSidebarPane = memo(function LeftSidebarPane({ collapsed }: { collapsed: boolean }) {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);

  return (
    <div
      className="app-left-sidebar-pane relative h-full min-h-0 shrink-0 overflow-hidden border-r border-border/70"
      style={{ width: collapsed ? 0 : sidebarWidth, borderRightWidth: collapsed ? 0 : 1 }}
    >
      <div className="absolute top-0 bottom-0 right-0 flex" style={{ width: sidebarWidth }}>
        <Sidebar />
      </div>
      {!collapsed ? <SidebarResizer /> : null}
    </div>
  );
});

const RightSidebarPane = memo(function RightSidebarPane({ collapsed }: { collapsed: boolean }) {
  const contextSidebarWidth = useAppStore((s) => s.contextSidebarWidth);
  const canvasSidebarWidth = useAppStore((s) => s.canvasSidebarWidth);
  const filePreview = useAppStore((s) => s.filePreview);
  const canvasEnabled = useAppStore((s) => s.desktopFeatureFlags?.canvas === true);

  const isCanvasSupported = filePreview?.path && isCanvasSupportedFile(filePreview.path);
  const showCanvas = canvasEnabled && isCanvasSupported;
  const activeWidth = showCanvas ? canvasSidebarWidth : contextSidebarWidth;

  return (
    <div
      className="app-right-sidebar-pane relative shrink-0 overflow-hidden"
      style={{ width: collapsed ? 0 : activeWidth }}
    >
      {!collapsed ? <ContextSidebarResizer /> : null}
      <div className="absolute top-0 bottom-0 left-0 flex" style={{ width: activeWidth }}>
        {showCanvas && filePreview?.path ? <Canvas path={filePreview.path} /> : <ContextSidebar />}
      </div>
    </div>
  );
});

let scheduledJsonRpcShutdownDisposal: number | null = null;

function cancelScheduledJsonRpcShutdownDisposal() {
  if (scheduledJsonRpcShutdownDisposal === null) {
    return;
  }
  window.clearTimeout(scheduledJsonRpcShutdownDisposal);
  scheduledJsonRpcShutdownDisposal = null;
}

function runJsonRpcShutdownDisposal() {
  cancelScheduledJsonRpcShutdownDisposal();
  disposeAllJsonRpcState();
}

function scheduleJsonRpcShutdownDisposal() {
  cancelScheduledJsonRpcShutdownDisposal();
  scheduledJsonRpcShutdownDisposal = window.setTimeout(() => {
    scheduledJsonRpcShutdownDisposal = null;
    disposeAllJsonRpcState();
  }, 0);
}

const ChatShell = memo(function ChatShell({
  init,
  ready,
  startupError,
}: {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
}) {
  const view = useAppStore((s) => s.view);
  const googleResearchAvailable = useAppStore((s) =>
    hasGoogleApiKeyForResearch(s.providerStatusByName.google),
  );
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const pluginManagementWorkspaceId = useAppStore((s) => s.pluginManagementWorkspaceId);
  const pluginManagementMode = useAppStore((s) => s.pluginManagementMode);
  const setPluginManagementWorkspace = useAppStore((s) => s.setPluginManagementWorkspace);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const openNewChatLanding = useAppStore((s) => s.openNewChatLanding);
  const clearThreadUsageHardCap = useAppStore((s) => s.clearThreadUsageHardCap);
  const contextSidebarCollapsed = useAppStore((s) => s.contextSidebarCollapsed);
  const toggleContextSidebar = useAppStore((s) => s.toggleContextSidebar);
  const filePreview = useAppStore((s) => s.filePreview);
  const canvasEnabled = useAppStore((s) => s.desktopFeatureFlags?.canvas === true);
  const closeFilePreview = useAppStore((s) => s.closeFilePreview);
  const canvasActiveTab = useAppStore((s) => s.canvasActiveTab);
  const setCanvasActiveTab = useAppStore((s) => s.setCanvasActiveTab);
  const canvasShowFormattingBar = useAppStore((s) => s.canvasShowFormattingBar);
  const setCanvasShowFormattingBar = useAppStore((s) => s.setCanvasShowFormattingBar);
  const hasAnimatedSidebarsRef = useRef(false);
  const previousSidebarStateRef = useRef({
    sidebarCollapsed,
    contextSidebarCollapsed,
  });

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const activeWorkspace = useMemo(() => {
    if (!activeThread) {
      return null;
    }
    return workspaces.find((workspace) => workspace.id === activeThread.workspaceId) ?? null;
  }, [activeThread, workspaces]);
  const projectWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace)),
    [workspaces],
  );
  const pluginSelection = useMemo(
    () =>
      resolvePluginCatalogWorkspaceSelection({
        workspaces: projectWorkspaces,
        selectedWorkspaceId,
        pluginManagementWorkspaceId,
        pluginManagementMode,
      }),
    [pluginManagementMode, pluginManagementWorkspaceId, projectWorkspaces, selectedWorkspaceId],
  );
  const pluginManagementWorkspace = useMemo(
    () =>
      projectWorkspaces.find((workspace) => workspace.id === pluginSelection.displayWorkspaceId) ??
      null,
    [pluginSelection.displayWorkspaceId, projectWorkspaces],
  );
  const runtime = selectedThreadId ? threadRuntimeById[selectedThreadId] : null;
  const busy = runtime?.busy === true;
  const effectiveView = view === "research" && !googleResearchAvailable ? "chat" : view;
  const showContextSidebar = effectiveView === "chat" && activeThread !== null;
  const catalogWorkspaceId = pluginSelection.catalogWorkspaceId;
  const pluginViewMode = catalogWorkspaceId
    ? (workspaceRuntimeById[catalogWorkspaceId]?.pluginViewMode ?? "plugins")
    : "plugins";
  const topBarTitle =
    effectiveView === "skills"
      ? pluginViewMode === "skills"
        ? "Skills"
        : "Plugins"
      : effectiveView === "research"
        ? "Research"
        : activeThread?.title?.trim() || "New thread";
  const topBarSubtitle: string | null =
    effectiveView === "skills"
      ? (pluginManagementWorkspace?.name ?? "Global")
      : effectiveView === "research"
        ? null
        : isOneOffChatWorkspace(activeWorkspace)
          ? null
          : (activeWorkspace?.name ?? "Cowork");
  const canClearHardCap =
    runtime?.sessionUsage?.budgetStatus.stopTriggered === true &&
    runtime?.transcriptOnly !== true &&
    runtime?.connected === true &&
    Boolean(runtime?.sessionId) &&
    activeThread?.status === "active";
  const quickChatPopOutThreadId =
    activeThread && canPopOutQuickChatThread(activeThread) ? activeThread.id : null;
  const canvasPath = filePreview?.path ?? null;
  const showCanvasInTopBar =
    effectiveView === "chat" &&
    canvasEnabled &&
    canvasPath !== null &&
    isCanvasSupportedFile(canvasPath) &&
    !contextSidebarCollapsed;
  const canvasIsMarkdown = canvasPath !== null && getFilePreviewKind(canvasPath) === "markdown";
  useEffect(() => {
    const sidebarStateChanged =
      previousSidebarStateRef.current.sidebarCollapsed !== sidebarCollapsed ||
      previousSidebarStateRef.current.contextSidebarCollapsed !== contextSidebarCollapsed;
    previousSidebarStateRef.current = {
      sidebarCollapsed,
      contextSidebarCollapsed,
    };

    if (!hasAnimatedSidebarsRef.current) {
      hasAnimatedSidebarsRef.current = true;
      return;
    }
    if (!sidebarStateChanged) {
      return;
    }
    document.body.classList.add("app-animating-sidebars");
    const timer = window.setTimeout(() => {
      document.body.classList.remove("app-animating-sidebars");
    }, 340);
    return () => {
      window.clearTimeout(timer);
      document.body.classList.remove("app-animating-sidebars");
    };
  }, [contextSidebarCollapsed, sidebarCollapsed]);

  return (
    <div className="app-shell app-shell--chat flex h-full min-h-0 flex-col text-foreground">
      <div className="app-window-drag-strip" aria-hidden="true" />
      <AppTopBar
        busy={effectiveView === "chat" ? busy : false}
        onToggleSidebar={toggleSidebar}
        onNewChat={() => void openNewChatLanding()}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={sidebarWidth}
        contextSidebarCollapsed={contextSidebarCollapsed}
        onToggleContextSidebar={toggleContextSidebar}
        onPopOutQuickChat={
          quickChatPopOutThreadId
            ? () => void showQuickChatWindow({ threadId: quickChatPopOutThreadId })
            : undefined
        }
        title={topBarTitle}
        subtitle={topBarSubtitle}
        managementMode={effectiveView === "skills" ? "plugins" : "thread"}
        suppressThreadDetails={effectiveView === "research"}
        hideThreadShell={effectiveView === "chat" && activeThread === null}
        managementWorkspaceId={pluginSelection.displayWorkspaceId}
        managementWorkspaces={projectWorkspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
        }))}
        onSelectManagementWorkspace={
          effectiveView === "skills"
            ? (workspaceId: string | null) => void setPluginManagementWorkspace(workspaceId)
            : undefined
        }
        sessionUsage={effectiveView === "chat" ? (runtime?.sessionUsage ?? null) : null}
        lastTurnUsage={effectiveView === "chat" ? (runtime?.lastTurnUsage ?? null) : null}
        canClearHardCap={canClearHardCap}
        onClearHardCap={
          selectedThreadId ? () => clearThreadUsageHardCap(selectedThreadId) : undefined
        }
        showContextToggle={showContextSidebar && !showCanvasInTopBar}
        canvasMode={showCanvasInTopBar}
        canvasIsMarkdown={canvasIsMarkdown}
        canvasActiveTab={canvasActiveTab}
        onSetCanvasActiveTab={setCanvasActiveTab}
        canvasShowFormattingBar={canvasShowFormattingBar}
        onToggleCanvasFormattingBar={() => setCanvasShowFormattingBar(!canvasShowFormattingBar)}
        onPopOutCanvas={
          showCanvasInTopBar && canvasPath
            ? () => {
                void showCanvasWindow({ path: canvasPath }).catch(() => {});
                closeFilePreview();
              }
            : undefined
        }
        onCloseCanvas={showCanvasInTopBar ? closeFilePreview : undefined}
      />
      <div className="app-chat-body flex min-h-0 min-w-0 flex-1 flex-row">
        <LeftSidebarPane collapsed={sidebarCollapsed} />
        <main className="app-main-content flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              <PrimaryContent
                init={init}
                ready={ready}
                startupError={startupError}
                view={
                  effectiveView === "skills"
                    ? "skills"
                    : effectiveView === "research"
                      ? "research"
                      : "chat"
                }
              />
            </div>
            {showContextSidebar ? <RightSidebarPane collapsed={contextSidebarCollapsed} /> : null}
          </div>
        </main>
      </div>
    </div>
  );
});

export default function App() {
  const windowMode = getDesktopWindowMode();
  const ready = useAppStore((s) => s.ready);
  const bootstrapPending = useAppStore((s) => s.bootstrapPending);
  const startupError = useAppStore((s) => s.startupError);
  const init = useAppStore((s) => s.init);
  const view = useAppStore((s) => s.view);
  const notifications = useAppStore((s) => s.notifications);
  const setUpdateState = useAppStore((s) => s.setUpdateState);
  const seenNotificationIds = useRef(new Set<string>());

  useEffect(() => {
    document.documentElement.dataset.windowMode = windowMode;
    return () => {
      delete document.documentElement.dataset.windowMode;
    };
  }, [windowMode]);

  useEffect(() => {
    if (ready && !bootstrapPending) return;
    void init().catch((err) => {
      console.error(err);
    });
  }, [bootstrapPending, init, ready]);

  useEffect(() => {
    cancelScheduledJsonRpcShutdownDisposal();
    let disposed = false;
    const handleBeforeUnload = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      runJsonRpcShutdownDisposal();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (disposed) {
        return;
      }
      scheduleJsonRpcShutdownDisposal();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const state = useAppStore.getState();
        if (state.onboardingVisible) {
          state.dismissOnboarding();
          return;
        }
        if (state.promptModal) {
          if (state.promptModal.kind === "ask") {
            state.answerAsk(
              state.promptModal.threadId,
              state.promptModal.prompt.requestId,
              ASK_SKIP_TOKEN,
            );
          } else {
            state.dismissPrompt();
          }
          return;
        }
        if (state.view === "settings") {
          state.closeSettings();
          return;
        }
        if (state.selectedThreadId) {
          const runtime = state.threadRuntimeById[state.selectedThreadId];
          if (runtime?.busy) {
            state.cancelThread(state.selectedThreadId);
          }
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    function handleMenuCommand(command: DesktopMenuCommand): void {
      const state = useAppStore.getState();
      if (command === "newThread") {
        void state.openNewChatLanding();
        return;
      }
      if (command === "toggleSidebar") {
        state.toggleSidebar();
        return;
      }
      if (command === "openSettings") {
        state.openSettings();
        return;
      }
      if (command === "openWorkspacesSettings") {
        state.openSettings("workspaces");
        return;
      }
      if (command === "openUpdates") {
        state.openSettings("updates");
        void state.checkForUpdates();
        return;
      }
      if (command === "openResearch") {
        void state.openResearch();
        return;
      }
      if (command === "openSkills") {
        void state.openSkills();
      }
    }

    const unsubscribe = onMenuCommand(handleMenuCommand);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = onUpdateStateChanged(setUpdateState);
    void getUpdateState()
      .then(setUpdateState)
      .catch(() => {
        // Keep the default disabled/idle state if the updater bridge is unavailable.
      });
    return unsubscribe;
  }, [setUpdateState]);

  useEffect(() => {
    function applySystemAppearance(appearance: SystemAppearance): void {
      const root = document.documentElement;
      const theme = appearance.shouldUseDarkColors ? "dark" : "light";
      root.dataset.systemTheme = theme;
      root.dataset.systemUiTheme = appearance.shouldUseDarkColorsForSystemIntegratedUI
        ? "dark"
        : "light";
      root.dataset.theme = theme;
      root.dataset.platform = appearance.platform;
      root.dataset.highContrast =
        appearance.shouldUseHighContrastColors || appearance.inForcedColorsMode ? "true" : "false";
      root.dataset.reducedTransparency = appearance.prefersReducedTransparency ? "true" : "false";
      syncPlatformChromeCssVars(document);
      root.style.colorScheme = theme;
      root.classList.toggle("dark", theme === "dark");
      root.classList.toggle("light", theme !== "dark");
    }

    const unsubscribe = onSystemAppearanceChanged(applySystemAppearance);
    void getSystemAppearance()
      .then(applySystemAppearance)
      .catch(() => {
        // Keep CSS media-query fallback when system appearance cannot be loaded.
      });
    void setWindowAppearance({ themeSource: "system" }).catch(() => {
      // Ignore and continue with default system theme behavior.
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    void getPlatformChrome()
      .then((chrome) => {
        applyPlatformChromeToDocument(document, chrome);
      })
      .catch(() => {
        // Fallback to defaults if platform chrome cannot be loaded.
      });
  }, []);

  useEffect(() => {
    if (windowMode !== "main") {
      return;
    }
    for (const notification of notifications) {
      if (seenNotificationIds.current.has(notification.id)) {
        continue;
      }
      seenNotificationIds.current.add(notification.id);
      void showNotification({
        title: notification.title,
        body: notification.detail,
      }).catch(() => {
        // Browser-style in-app notifications already exist; OS toast is best effort.
      });
    }
  }, [notifications, windowMode]);

  return (
    <>
      {windowMode === "quick-chat" ? (
        <QuickChatShell init={init} ready={ready} startupError={startupError} />
      ) : windowMode === "utility" ? (
        <MenuBarUtilityShell init={init} ready={ready} startupError={startupError} />
      ) : windowMode === "canvas" ? (
        <div
          className="flex h-full w-full bg-[var(--surface-sidebar-pane)] relative flex-col"
          style={
            {
              backdropFilter: "blur(var(--sidebar-blur, 0px))",
              WebkitBackdropFilter: "blur(var(--sidebar-blur, 0px))",
            } as CSSProperties
          }
        >
          <div className="flex-1 min-h-0 min-w-0">
            <Canvas path={new URLSearchParams(window.location.search).get("path") || ""} />
          </div>
        </div>
      ) : view === "settings" ? (
        <div className="app-shell app-shell--settings flex h-full min-h-0 flex-col text-foreground">
          <div className="app-window-drag-strip" aria-hidden="true" />
          <div className="min-h-0 flex-1">
            <SettingsContent init={init} ready={ready} startupError={startupError} />
          </div>
        </div>
      ) : (
        <ChatShell init={init} ready={ready} startupError={startupError} />
      )}
      <PromptModal />
      <FilePreviewModal />
      {windowMode === "main" ? <DesktopOnboarding /> : null}
    </>
  );
}
