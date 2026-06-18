import type { CSSProperties } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

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
import { cn } from "./lib/utils";
import { getDesktopWindowMode } from "./lib/windowMode";
import { ASK_SKIP_TOKEN } from "./lib/wsProtocol";
import { Canvas } from "./ui/Canvas";
import { CommandPalette } from "./ui/CommandPalette";
import { ContextSidebar } from "./ui/ContextSidebar";
import { InlineErrorBoundary } from "./ui/CrashReportingErrorBoundary";
import { FilePreviewModal } from "./ui/FilePreviewModal";
import { AppTopBar } from "./ui/layout/AppTopBar";
import { ContextSidebarResizer } from "./ui/layout/ContextSidebarResizer";
import { PrimaryContent } from "./ui/layout/PrimaryContent";
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
  const isCanvasMaximized = useAppStore((s) => s.isCanvasMaximized);

  const isCanvasSupported = filePreview?.path && isCanvasSupportedFile(filePreview.path);
  const showCanvas = canvasEnabled && isCanvasSupported;
  const canvasMaximized = showCanvas && isCanvasMaximized;
  const activeWidth = showCanvas && !canvasMaximized ? canvasSidebarWidth : contextSidebarWidth;
  const canvasContainerStyle: CSSProperties = canvasMaximized
    ? {
        top: "calc(var(--platform-drag-strip-height) + var(--platform-titlebar-height))",
        right: 0,
        bottom: 0,
        left: 0,
      }
    : { width: activeWidth };

  return (
    <div
      className={cn(
        "app-right-sidebar-pane relative shrink-0",
        canvasMaximized ? "overflow-visible" : "overflow-hidden",
      )}
      style={{ width: collapsed || canvasMaximized ? 0 : activeWidth }}
    >
      {!collapsed && !canvasMaximized ? <ContextSidebarResizer /> : null}
      <div
        className={cn(
          "flex bg-background",
          canvasMaximized ? "fixed z-40" : "absolute top-0 bottom-0 left-0",
        )}
        style={canvasContainerStyle}
      >
        {showCanvas && filePreview?.path ? (
          <InlineErrorBoundary label="This canvas couldn't be rendered.">
            <Canvas path={filePreview.path} />
          </InlineErrorBoundary>
        ) : (
          <ContextSidebar />
        )}
      </div>
    </div>
  );
});

function runJsonRpcShutdownDisposal() {
  disposeAllJsonRpcState();
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
  const isCanvasMaximized = useAppStore((s) => s.isCanvasMaximized);
  const setCanvasMaximized = useAppStore((s) => s.setCanvasMaximized);
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
    (!contextSidebarCollapsed || isCanvasMaximized);
  const canvasKind = canvasPath !== null ? getFilePreviewKind(canvasPath) : "other";
  const canvasIsMarkdown = canvasKind === "markdown";
  const canvasIsSpreadsheet = canvasKind === "csv" || canvasKind === "xlsx";
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
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-md focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:outline-none focus:ring-2 focus:ring-ring/50"
      >
        Skip to content
      </a>
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
        agents={effectiveView === "chat" ? (runtime?.agents ?? []) : []}
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
        canvasMaximized={isCanvasMaximized}
        onToggleCanvasMaximized={
          showCanvasInTopBar ? () => setCanvasMaximized(!isCanvasMaximized) : undefined
        }
        onPopOutCanvas={
          showCanvasInTopBar && canvasPath && !canvasIsSpreadsheet
            ? () => {
                void showCanvasWindow({ path: canvasPath }).catch(() => {});
              }
            : undefined
        }
        onCloseCanvas={showCanvasInTopBar ? closeFilePreview : undefined}
      />
      <div className="app-chat-body relative flex min-h-0 min-w-0 flex-1 flex-row">
        <LeftSidebarPane collapsed={sidebarCollapsed} />
        <main
          id="main-content"
          tabIndex={-1}
          aria-label={
            effectiveView === "settings"
              ? "Settings"
              : effectiveView === "skills"
                ? "Skills and plugins"
                : effectiveView === "research"
                  ? "Research"
                  : "Chat"
          }
          className="app-main-content flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        >
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
                      : effectiveView === "settings"
                        ? "settings"
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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

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
        const hasPendingSandboxApproval = Object.values(state.sandboxApprovalsByThread).some(
          (pending) => pending.length > 0,
        );
        if (hasPendingSandboxApproval) {
          state.dismissPrompt();
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

  // Cmd/Ctrl+K opens the command palette. Scoped to the main window so the
  // popout quick-chat / menu-bar / canvas windows keep their minimal shells.
  useEffect(() => {
    if (windowMode !== "main") return;
    function handlePaletteShortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === "k"
      ) {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handlePaletteShortcut);
    return () => window.removeEventListener("keydown", handlePaletteShortcut);
  }, [windowMode]);

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
        state.openSettings("defaults");
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
          className="relative flex h-full w-full flex-col bg-[var(--surface-spreadsheet)] text-[var(--text-spreadsheet)]"
          style={
            {
              colorScheme: "light",
            } as CSSProperties
          }
        >
          <div className="flex-1 min-h-0 min-w-0">
            <InlineErrorBoundary label="This canvas couldn't be rendered.">
              <Canvas path={new URLSearchParams(window.location.search).get("path") || ""} />
            </InlineErrorBoundary>
          </div>
        </div>
      ) : (
        <ChatShell init={init} ready={ready} startupError={startupError} />
      )}
      <PromptModal />
      {windowMode === "main" ? <FilePreviewModal /> : null}
      {windowMode === "main" ? (
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      ) : null}
      {windowMode === "main" ? <DesktopOnboarding /> : null}
    </>
  );
}
