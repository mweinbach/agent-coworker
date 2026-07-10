import type { CSSProperties } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { hasGoogleApiKeyForResearch } from "./app/researchAvailability";
import { isSandboxApprovalThreadVisible } from "./app/sandboxApprovalVisibility";
import { useAppStore } from "./app/store";
import { disposeAllJsonRpcState } from "./app/store.helpers";
import { isOneOffChatWorkspace } from "./app/types";
import { Button } from "./components/ui/button";
import type { DesktopMenuCommand, SystemAppearance } from "./lib/desktopApi";
import {
  confirmAction,
  getPlatformChrome,
  getSystemAppearance,
  onMenuCommand,
  onSystemAppearanceChanged,
  onUpdateStateChanged,
  onWorkspaceServerExited,
  onWorkspaceServerStartupProgress,
  setWindowAppearance,
  showCanvasWindow,
  showNotification,
  showQuickChatWindow,
  writeRendererLog,
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
import { shouldShowReconnectBanner } from "./ui/chat/chatLogic";
import { LmStudioStartDialog } from "./ui/chat/LmStudioStartDialog";
import { FilePreviewModal } from "./ui/FilePreviewModal";
import { InAppToasts } from "./ui/InAppToasts";
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
import { TranscriptDeliveryRecovery } from "./ui/TranscriptDeliveryRecovery";
import { TaskContextSidebar } from "./ui/tasks/TaskContextSidebar";

const EMPTY_AGENTS: never[] = [];

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
  const view = useAppStore((s) => s.view);

  const isCanvasSupported = filePreview?.path && isCanvasSupportedFile(filePreview.path);
  const showCanvas = canvasEnabled && isCanvasSupported;
  const canvasMaximized = showCanvas && isCanvasMaximized;
  const activeWidth =
    showCanvas && !canvasMaximized
      ? canvasSidebarWidth
      : view === "task"
        ? Math.max(contextSidebarWidth, 360)
        : contextSidebarWidth;
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
        ) : view === "task" ? (
          <TaskContextSidebar variant="sidebar" />
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
  bootstrapLoading,
}: {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
  bootstrapLoading: boolean;
}) {
  const view = useAppStore((s) => s.view);
  const googleResearchAvailable = useAppStore((s) =>
    hasGoogleApiKeyForResearch(s.providerStatusByName.google),
  );
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedTask = useAppStore((s) =>
    s.selectedTaskId ? s.tasksById[s.selectedTaskId] : null,
  );
  const selectedThreadBusy = useAppStore((s) =>
    s.selectedThreadId ? s.threadRuntimeById[s.selectedThreadId]?.busy === true : false,
  );
  const selectedSessionUsage = useAppStore((s) =>
    s.selectedThreadId ? (s.threadRuntimeById[s.selectedThreadId]?.sessionUsage ?? null) : null,
  );
  const selectedLastTurnUsage = useAppStore((s) =>
    s.selectedThreadId ? (s.threadRuntimeById[s.selectedThreadId]?.lastTurnUsage ?? null) : null,
  );
  const selectedAgents = useAppStore((s) => {
    if (!s.selectedThreadId) return EMPTY_AGENTS;
    return s.threadRuntimeById[s.selectedThreadId]?.agents ?? EMPTY_AGENTS;
  });
  const selectedSessionUsageStop = useAppStore((s) =>
    s.selectedThreadId
      ? s.threadRuntimeById[s.selectedThreadId]?.sessionUsage?.budgetStatus.stopTriggered === true
      : false,
  );
  const selectedTranscriptOnly = useAppStore((s) =>
    s.selectedThreadId ? s.threadRuntimeById[s.selectedThreadId]?.transcriptOnly === true : false,
  );
  const selectedConnected = useAppStore((s) =>
    s.selectedThreadId ? s.threadRuntimeById[s.selectedThreadId]?.connected === true : false,
  );
  const selectedHydrating = useAppStore((s) =>
    s.selectedThreadId ? s.threadRuntimeById[s.selectedThreadId]?.hydrating === true : false,
  );
  const selectedRuntimeExists = useAppStore((s) =>
    s.selectedThreadId ? s.threadRuntimeById[s.selectedThreadId] !== undefined : false,
  );
  const selectedSessionId = useAppStore((s) =>
    s.selectedThreadId ? (s.threadRuntimeById[s.selectedThreadId]?.sessionId ?? null) : null,
  );
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
    const workspaceId = activeThread?.workspaceId ?? selectedWorkspaceId;
    return workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }, [activeThread, selectedWorkspaceId, workspaces]);
  const busy = selectedThreadBusy;
  const effectiveView = view === "research" && !googleResearchAvailable ? "chat" : view;
  const isConversationView = effectiveView === "chat" || effectiveView === "task";
  const showContextSidebar =
    (effectiveView === "chat" && activeThread !== null) ||
    (effectiveView === "task" && selectedTask !== null);
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const workspaceStartupProgress = useMemo(() => {
    const activeRuntime = activeWorkspaceId ? workspaceRuntimeById[activeWorkspaceId] : null;
    if (activeRuntime?.starting && !activeRuntime.serverUrl && activeRuntime.startupProgress) {
      return activeRuntime.startupProgress;
    }
    if (activeWorkspaceId) return null;
    for (const runtime of Object.values(workspaceRuntimeById)) {
      if (runtime.starting && !runtime.serverUrl && runtime.startupProgress) {
        return runtime.startupProgress;
      }
    }
    return null;
  }, [activeWorkspaceId, workspaceRuntimeById]);
  const topBarTitle =
    effectiveView === "research"
      ? "Research"
      : effectiveView === "task"
        ? (selectedTask?.title ?? "New task")
        : activeThread?.title?.trim() || "New chat";
  const topBarSubtitle: string | null =
    effectiveView === "research"
      ? null
      : isOneOffChatWorkspace(activeWorkspace)
        ? null
        : (activeWorkspace?.name ?? "Cowork");
  const canClearHardCap =
    selectedSessionUsageStop &&
    !selectedTranscriptOnly &&
    selectedConnected &&
    Boolean(selectedSessionId) &&
    activeThread?.status === "active";
  const quickChatPopOutThreadId =
    effectiveView === "chat" && activeThread && canPopOutQuickChatThread(activeThread)
      ? activeThread.id
      : null;
  const canvasPath = filePreview?.path ?? null;
  const showCanvasInTopBar =
    isConversationView &&
    canvasEnabled &&
    canvasPath !== null &&
    isCanvasSupportedFile(canvasPath) &&
    (!contextSidebarCollapsed || isCanvasMaximized);
  const canvasKind = canvasPath !== null ? getFilePreviewKind(canvasPath) : "other";
  const canvasIsMarkdown = canvasKind === "markdown";
  const canvasIsSpreadsheet = canvasKind === "csv" || canvasKind === "xlsx";
  const terminalTaskConversation =
    effectiveView === "task" &&
    selectedTask !== null &&
    (selectedTask.status === "completed" ||
      selectedTask.status === "cancelled" ||
      selectedTask.status === "failed");
  const showReconnectBanner = shouldShowReconnectBanner({
    conversationVisible: isConversationView,
    threadId: selectedThreadId,
    threadStatus: activeThread?.status ?? null,
    transcriptOnly: selectedTranscriptOnly,
    connected: selectedConnected,
    sessionId: selectedSessionId,
    hydrating:
      selectedHydrating ||
      (bootstrapLoading &&
        Boolean(selectedThreadId) &&
        activeThread !== null &&
        !selectedRuntimeExists),
    workspaceStarting: workspaceStartupProgress !== null,
    terminalTaskConversation,
  });
  useEffect(() => {
    const documentBody = document.body;
    const windowTarget = window;
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
    documentBody.classList.add("app-animating-sidebars");
    const timer = windowTarget.setTimeout(() => {
      documentBody.classList.remove("app-animating-sidebars");
    }, 340);
    return () => {
      windowTarget.clearTimeout(timer);
      documentBody.classList.remove("app-animating-sidebars");
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
        busy={isConversationView ? busy : false}
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
        suppressThreadDetails={effectiveView === "research"}
        hideThreadShell={isConversationView && activeThread === null}
        sessionUsage={isConversationView ? selectedSessionUsage : null}
        lastTurnUsage={isConversationView ? selectedLastTurnUsage : null}
        agents={isConversationView ? selectedAgents : []}
        canClearHardCap={canClearHardCap}
        onClearHardCap={
          selectedThreadId ? () => clearThreadUsageHardCap(selectedThreadId) : undefined
        }
        showContextToggle={
          showContextSidebar && !showCanvasInTopBar && workspaceStartupProgress === null
        }
        canvasMode={showCanvasInTopBar}
        canvasIsMarkdown={canvasIsMarkdown}
        canvasActiveTab={canvasActiveTab}
        onSetCanvasActiveTab={setCanvasActiveTab}
        canvasShowFormattingBar={canvasShowFormattingBar}
        onToggleCanvasFormattingBar={
          canvasIsMarkdown && canvasActiveTab === "edit"
            ? () => setCanvasShowFormattingBar(!canvasShowFormattingBar)
            : undefined
        }
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
      {showReconnectBanner ? (
        <div
          role="status"
          data-slot="connection-banner"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-warning/15 px-4 py-2 text-sm text-foreground"
        >
          <span className="min-w-0 truncate">
            Disconnected from this chat. Reconnect to continue.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (selectedThreadId) void useAppStore.getState().reconnectThread(selectedThreadId);
            }}
          >
            Reconnect
          </Button>
        </div>
      ) : null}
      <div className="app-chat-body relative flex min-h-0 min-w-0 flex-1 flex-row">
        <LeftSidebarPane collapsed={sidebarCollapsed} />
        <main
          id="main-content"
          tabIndex={-1}
          aria-label={
            effectiveView === "settings"
              ? "Settings"
              : effectiveView === "research"
                ? "Research"
                : effectiveView === "task"
                  ? "Task"
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
                workspaceStartupProgress={workspaceStartupProgress}
                view={
                  effectiveView === "research"
                    ? "research"
                    : effectiveView === "task"
                      ? "task"
                      : "chat"
                }
              />
            </div>
            {showContextSidebar && workspaceStartupProgress === null ? (
              <RightSidebarPane collapsed={contextSidebarCollapsed} />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
});

export default function App() {
  const windowMode = getDesktopWindowMode();
  const ready = useAppStore((s) => s.ready);
  const bootstrapPhase = useAppStore((s) => s.bootstrapPhase);
  const startupError = useAppStore((s) => s.startupError);
  const init = useAppStore((s) => s.init);
  const invalidateBootstrap = useAppStore((s) => s.invalidateBootstrap);
  const view = useAppStore((s) => s.view);
  const notifications = useAppStore((s) => s.notifications);
  const setUpdateState = useAppStore((s) => s.setUpdateState);
  const handleWorkspaceServerExited = useAppStore((s) => s.handleWorkspaceServerExited);
  const setWorkspaceServerStartupProgress = useAppStore((s) => s.setWorkspaceServerStartupProgress);
  const seenNotificationIds = useRef(new Set<string>());
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useEffect(
    () =>
      onWorkspaceServerStartupProgress((event) => {
        void writeRendererLog({
          category: "sidecar",
          message: "workspace server startup progress",
          meta: {
            workspaceId: event.workspaceId,
            phase: event.progress.phase,
            version: event.progress.version,
            percent: event.progress.percent,
          },
        }).catch(() => {});
        setWorkspaceServerStartupProgress(event);
      }),
    [setWorkspaceServerStartupProgress],
  );

  useEffect(() => {
    if (windowMode !== "main") return;
    return onWorkspaceServerExited((event) => {
      void writeRendererLog({
        category: "sidecar",
        message: "workspace server exited",
        meta: {
          workspaceId: event.workspaceId,
          code: event.code,
          signal: event.signal,
        },
      }).catch(() => {});
      handleWorkspaceServerExited(event);
    });
  }, [handleWorkspaceServerExited, windowMode]);

  useEffect(() => {
    const documentElement = document.documentElement;
    documentElement.dataset.windowMode = windowMode;
    return () => {
      delete documentElement.dataset.windowMode;
    };
  }, [windowMode]);

  useEffect(() => {
    if (bootstrapPhase !== "idle") return;
    void init().catch((err) => {
      console.error(err);
    });
  }, [bootstrapPhase, init]);

  useEffect(() => {
    let disposed = false;
    const windowTarget = window;
    const handleBeforeUnload = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      invalidateBootstrap();
      runJsonRpcShutdownDisposal();
    };

    windowTarget.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      windowTarget.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [invalidateBootstrap]);

  useEffect(() => {
    const windowTarget = window;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const state = useAppStore.getState();
        if (state.onboardingVisible) {
          // Onboarding owns Escape; do not also cancel a busy turn.
          event.preventDefault();
          // Incomplete first-run setup: do not fully dismiss without confirmation.
          const hasConnectedProvider =
            state.providerConnected.length > 0 ||
            Object.values(state.providerStatusByName).some(
              (status) => status?.authorized === true || status?.verified === true,
            );
          const incompleteSetup = state.workspaces.length === 0 || !hasConnectedProvider;
          if (incompleteSetup) {
            void confirmAction({
              title: "Skip setup?",
              message: "You have not finished connecting a provider or adding a workspace yet.",
              detail:
                "You can reopen setup later from Settings, but Cowork may feel incomplete until then.",
              confirmLabel: "Skip for now",
              cancelLabel: "Continue setup",
              kind: "warning",
              defaultAction: "cancel",
            }).then((confirmed) => {
              if (confirmed) {
                state.dismissOnboarding();
              }
            });
            return;
          }
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
        const hasPendingSandboxApproval = Object.entries(state.sandboxApprovalsByThread).some(
          ([threadId, pending]) =>
            pending.length > 0 && isSandboxApprovalThreadVisible(state, threadId),
        );
        if (hasPendingSandboxApproval) {
          event.preventDefault();
          event.stopImmediatePropagation();
          state.dismissPrompt();
          return;
        }
        if (state.view === "settings") {
          // An open modal surface (Dialog/Sheet/menu) owns Escape: Radix marks
          // the event consumed when it dismisses a layer, and the DOM check
          // covers overlays that don't. Mirrors the SettingsShell guard.
          if (event.defaultPrevented) return;
          if (document.querySelector('[role="dialog"][data-state="open"]')) return;
          state.closeSettings();
          return;
        }
        // Layers own Escape before turn cancel (popover/dialog/menu/palette).
        if (event.defaultPrevented) return;
        if (
          document.querySelector(
            '[role="dialog"][data-state="open"], [data-radix-menu-content], [data-slot="command-dialog"][data-state="open"]',
          )
        ) {
          return;
        }
        if (commandPaletteOpen) {
          setCommandPaletteOpen(false);
          event.preventDefault();
          return;
        }
        if (state.selectedThreadId) {
          const runtime = state.threadRuntimeById[state.selectedThreadId];
          if (runtime?.busy) {
            event.preventDefault();
            state.cancelThread(state.selectedThreadId);
          }
        }
      }
    }

    windowTarget.addEventListener("keydown", handleKeyDown);
    return () => windowTarget.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteOpen]);

  // Cmd/Ctrl+K opens the command palette. Scoped to the main window so the
  // popout quick-chat / menu-bar / canvas windows keep their minimal shells.
  useEffect(() => {
    if (windowMode !== "main") return;
    const windowTarget = window;
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
    windowTarget.addEventListener("keydown", handlePaletteShortcut);
    return () => windowTarget.removeEventListener("keydown", handlePaletteShortcut);
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
        return;
      }
      if (command === "openCommandPalette") {
        setCommandPaletteOpen(true);
      }
    }

    const unsubscribe = onMenuCommand(handleMenuCommand);
    return unsubscribe;
  }, []);

  useEffect(() => {
    return onUpdateStateChanged(setUpdateState);
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
      try {
        // Survives reload so the pre-paint script in index.html can match the
        // last resolved theme (including forced light/dark) before React boots.
        localStorage.setItem("cowork.resolvedTheme", theme);
      } catch {
        // Private mode / storage quota — media-query FOUC fallback still works.
      }
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
      ) : view === "settings" ? (
        <div className="app-shell app-shell--settings flex h-full min-h-0 flex-col text-foreground">
          <div className="app-window-drag-strip" aria-hidden="true" />
          <div className="min-h-0 flex-1">
            <SettingsContent init={init} ready={ready} startupError={startupError} />
          </div>
        </div>
      ) : (
        <ChatShell
          init={init}
          ready={ready}
          startupError={startupError}
          bootstrapLoading={bootstrapPhase === "loading"}
        />
      )}
      <PromptModal />
      <LmStudioStartDialog />
      {windowMode === "main" ? <FilePreviewModal /> : null}
      {windowMode === "main" ? (
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      ) : null}
      {windowMode === "main" ? <DesktopOnboarding /> : null}
      {windowMode === "main" ? <TranscriptDeliveryRecovery /> : null}
      {windowMode === "main" ? <InAppToasts /> : null}
    </>
  );
}
