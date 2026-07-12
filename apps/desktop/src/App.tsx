import type { CSSProperties } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "./app/store";
import { type BootstrapStage, disposeAllJsonRpcState } from "./app/store.helpers";
import { operationKey } from "./app/store.helpers/operations";
import { isOneOffChatWorkspace } from "./app/types";
import { Spinner } from "./components/ui/spinner";
import { resolveRightRailSizing } from "./lib/adaptiveLayout";
import { getCanvasSurfaceKind } from "./lib/canvasAppearance";
import { requestCanvasDocumentTransition } from "./lib/canvasDocumentLifecycle";
import type { DesktopMenuCommand, SystemAppearance } from "./lib/desktopApi";
import {
  getPlatformChrome,
  getSystemAppearance,
  onMenuCommand,
  onPreviewFileChanged,
  onSystemAppearanceChanged,
  onUpdateStateChanged,
  onWindowCloseRequested,
  onWorkspaceServerExited,
  onWorkspaceServerStartupProgress,
  resolveWindowCloseRequest,
  setWindowAppearance,
  showCanvasWindow,
  showNotification,
  showQuickChatWindow,
  writeRendererLog,
} from "./lib/desktopCommands";
import { onDesktopRailCommand, requestDesktopRailCommand } from "./lib/desktopRailCommands";
import { getFilePreviewKind, isCanvasSupportedFile } from "./lib/filePreviewKind";
import { workspaceFileChangeEvents } from "./lib/filePreviewResource";
import { applyPlatformChromeToDocument, syncPlatformChromeCssVars } from "./lib/platformChromeDom";
import { canPopOutQuickChatThread } from "./lib/quickChatPopout";
import { applySystemAppearanceToDocument, readBootstrappedThemeSource } from "./lib/themeBootstrap";
import { useAdaptiveLayout } from "./lib/useAdaptiveLayout";
import { cn } from "./lib/utils";
import { getDesktopWindowMode } from "./lib/windowMode";
import { Canvas } from "./ui/Canvas";
import { CommandPalette } from "./ui/CommandPalette";
import { ConnectionRecoveryBanner } from "./ui/ConnectionRecoveryBanner";
import { ContextSidebar } from "./ui/ContextSidebar";
import { InlineErrorBoundary } from "./ui/CrashReportingErrorBoundary";
import { shouldShowReconnectBanner } from "./ui/chat/chatLogic";
import { LmStudioStartDialog } from "./ui/chat/LmStudioStartDialog";
import { FilePreviewModal } from "./ui/FilePreviewModal";
import { InAppToasts } from "./ui/InAppToasts";
import { AdaptiveRailSurface } from "./ui/layout/AdaptiveRailSurface";
import { AppTopBar } from "./ui/layout/AppTopBar";
import { ContextSidebarResizer } from "./ui/layout/ContextSidebarResizer";
import { PrimaryContent } from "./ui/layout/PrimaryContent";
import { SettingsContent } from "./ui/layout/SettingsContent";
import { SidebarResizer } from "./ui/layout/SidebarResizer";
import { MenuBarUtilityShell } from "./ui/menuBar/MenuBarUtilityShell";
import { isEditableEscapeTarget, OverlayStackProvider, useOverlayStack } from "./ui/OverlayStack";
import { DesktopOnboarding } from "./ui/onboarding/DesktopOnboarding";
import { QuickChatShell } from "./ui/quickChat/QuickChatShell";
import { StartupRecovery } from "./ui/recovery/StartupRecovery";
import { startupStagePresentation } from "./ui/recovery/startupPresentation";
import { Sidebar } from "./ui/Sidebar";
import { TranscriptDeliveryRecovery } from "./ui/TranscriptDeliveryRecovery";
import { TaskContextSidebar } from "./ui/tasks/TaskContextSidebar";

const EMPTY_AGENTS: never[] = [];

const LeftSidebarPane = memo(function LeftSidebarPane({
  active,
  maximumWidth,
  onClose,
  overlay,
  width,
}: {
  active: boolean;
  maximumWidth: number;
  onClose: () => void;
  overlay: boolean;
  width: number;
}) {
  return (
    <AdaptiveRailSurface
      active={active}
      className="app-left-sidebar-pane h-full border-r border-border/70"
      label="Sidebar"
      onClose={onClose}
      overlay={overlay}
      side="left"
      width={width}
    >
      <div className="absolute inset-y-0 right-0 flex w-full">
        <Sidebar />
      </div>
      {active && !overlay ? (
        <SidebarResizer effectiveWidth={width} maximumWidth={maximumWidth} />
      ) : null}
    </AdaptiveRailSurface>
  );
});

const RightSidebarPane = memo(function RightSidebarPane({
  active,
  maximumWidth,
  minimumWidth,
  onClose,
  overlay,
  width,
}: {
  active: boolean;
  maximumWidth: number;
  minimumWidth: number;
  onClose: () => void;
  overlay: boolean;
  width: number;
}) {
  const filePreview = useAppStore((s) => s.filePreview);
  const canvasEnabled = useAppStore((s) => s.desktopFeatureFlags?.canvas === true);
  const isCanvasMaximized = useAppStore((s) => s.isCanvasMaximized);
  const view = useAppStore((s) => s.view);

  const isCanvasSupported = filePreview?.path && isCanvasSupportedFile(filePreview.path);
  const showCanvas = canvasEnabled && isCanvasSupported;
  const canvasMaximized = showCanvas && isCanvasMaximized;
  const canvasContainerStyle: CSSProperties = canvasMaximized
    ? {
        top: "calc(var(--platform-drag-strip-height) + var(--platform-titlebar-height))",
        right: 0,
        bottom: 0,
        left: 0,
      }
    : { width: "100%" };

  return (
    <AdaptiveRailSurface
      active={canvasMaximized || active}
      className={cn(
        "app-right-sidebar-pane h-full",
        canvasMaximized ? "overflow-visible" : "overflow-hidden",
      )}
      label="Context"
      onClose={onClose}
      overlay={!canvasMaximized && overlay}
      side="right"
      width={canvasMaximized ? 0 : width}
    >
      {active && !overlay && !canvasMaximized ? (
        <ContextSidebarResizer
          effectiveWidth={width}
          maximumWidth={maximumWidth}
          minimumWidth={minimumWidth}
        />
      ) : null}
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
          <ContextSidebar active={canvasMaximized || active} />
        )}
      </div>
    </AdaptiveRailSurface>
  );
});

function runJsonRpcShutdownDisposal() {
  disposeAllJsonRpcState();
}

export function isStopTurnShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ".";
}

const ChatShell = memo(function ChatShell({
  init,
  ready,
  startupError,
  bootstrapLoading,
  bootstrapStage,
}: {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
  bootstrapLoading: boolean;
  bootstrapStage: BootstrapStage | null;
}) {
  const view = useAppStore((s) => s.view);
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
  const operationsByKey = useAppStore((s) => s.operationsByKey);
  const reconnectThreadWithFeedback = useAppStore((s) => s.reconnectThreadWithFeedback);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const openNewChatLanding = useAppStore((s) => s.openNewChatLanding);
  const clearThreadUsageHardCap = useAppStore((s) => s.clearThreadUsageHardCap);
  const contextSidebarCollapsed = useAppStore((s) => s.contextSidebarCollapsed);
  const contextSidebarWidth = useAppStore((s) => s.contextSidebarWidth);
  const canvasSidebarWidth = useAppStore((s) => s.canvasSidebarWidth);
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
  const [leftOverlayOpen, setLeftOverlayOpen] = useState(false);
  const [rightOverlayOpen, setRightOverlayOpen] = useState(false);
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
  const effectiveView = view;
  const isConversationView = effectiveView === "chat" || effectiveView === "task";
  const showContextSidebar =
    (effectiveView === "chat" && activeThread !== null) ||
    (effectiveView === "task" && selectedTask !== null);
  const canvasPath = filePreview?.path ?? null;
  const canvasSupported = canvasPath !== null && isCanvasSupportedFile(canvasPath);
  const showCanvasSurface = isConversationView && canvasEnabled && canvasSupported;
  const rightRailKind = showCanvasSurface
    ? "canvas"
    : effectiveView === "task"
      ? "task"
      : "context";
  const rightRailSizing = resolveRightRailSizing(rightRailKind, {
    canvas: canvasSidebarWidth,
    context: contextSidebarWidth,
  });
  const adaptiveLayout = useAdaptiveLayout({
    contextSidebarCollapsed,
    hasContextSidebar: showContextSidebar,
    leftSidebarWidth: sidebarWidth,
    rightSidebarMaximumWidth: rightRailSizing.maximumWidth,
    rightSidebarMinimumWidth: rightRailSizing.minimumWidth,
    rightSidebarWidth: rightRailSizing.preferredWidth,
    sidebarCollapsed,
  });
  const leftOverlayWidth = Math.max(160, Math.min(440, sidebarWidth));
  const rightOverlayWidth = rightRailSizing.preferredWidth;
  const leftRailActive =
    adaptiveLayout.leftInline || (adaptiveLayout.leftOverlay && leftOverlayOpen);
  const rightRailActive =
    adaptiveLayout.rightInline || (adaptiveLayout.rightOverlay && rightOverlayOpen);
  const leftRailWidth = adaptiveLayout.leftOverlay ? leftOverlayWidth : adaptiveLayout.leftWidth;
  const rightRailWidth = adaptiveLayout.rightOverlay
    ? rightOverlayWidth
    : adaptiveLayout.rightWidth;
  const toggleAdaptiveSidebar = useCallback(() => {
    if (adaptiveLayout.leftOverlay) {
      setLeftOverlayOpen((open) => !open);
      return;
    }
    toggleSidebar();
  }, [adaptiveLayout.leftOverlay, toggleSidebar]);
  const toggleAdaptiveContextSidebar = useCallback(() => {
    if (adaptiveLayout.rightOverlay) {
      setRightOverlayOpen((open) => !open);
      return;
    }
    toggleContextSidebar();
  }, [adaptiveLayout.rightOverlay, toggleContextSidebar]);
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
  const showCanvasInTopBar = showCanvasSurface && (rightRailActive || isCanvasMaximized);
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
  const reconnectOperation = selectedThreadId
    ? operationsByKey[operationKey("thread-reconnect", selectedThreadId)]
    : undefined;
  const preserveCachedContentOnStartupError =
    Boolean(startupError) && ready && (workspaces.length > 0 || threads.length > 0);
  const startupPresentation = startupStagePresentation(bootstrapStage);
  const activeCanvasPath = showCanvasSurface ? canvasPath : null;
  const previousCanvasPathRef = useRef<string | null>(null);
  const overlayScope = `${adaptiveLayout.tier}:${effectiveView}:${selectedThreadId ?? "none"}`;
  const previousOverlayScopeRef = useRef(overlayScope);

  useEffect(() => {
    if (previousOverlayScopeRef.current === overlayScope) return;
    previousOverlayScopeRef.current = overlayScope;
    setLeftOverlayOpen(false);
    setRightOverlayOpen(false);
  }, [overlayScope]);

  useEffect(() => {
    const previousCanvasPath = previousCanvasPathRef.current;
    previousCanvasPathRef.current = activeCanvasPath;
    if (
      adaptiveLayout.rightOverlay &&
      activeCanvasPath !== null &&
      activeCanvasPath !== previousCanvasPath
    ) {
      setRightOverlayOpen(true);
    }
  }, [activeCanvasPath, adaptiveLayout.rightOverlay]);

  useEffect(
    () =>
      onDesktopRailCommand((command) => {
        if (command === "toggle-sidebar") {
          toggleAdaptiveSidebar();
        } else {
          toggleAdaptiveContextSidebar();
        }
      }),
    [toggleAdaptiveContextSidebar, toggleAdaptiveSidebar],
  );

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
    <div
      className="app-shell app-shell--chat flex h-full min-h-0 flex-col text-foreground"
      data-layout-tier={adaptiveLayout.tier}
    >
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-md focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:outline-none focus:ring-2 focus:ring-ring/50"
      >
        Skip to content
      </a>
      <div className="app-window-drag-strip" aria-hidden="true" />
      <AppTopBar
        busy={isConversationView ? busy : false}
        onToggleSidebar={toggleAdaptiveSidebar}
        onNewChat={() => void openNewChatLanding()}
        sidebarCollapsed={!adaptiveLayout.leftInline}
        sidebarWidth={adaptiveLayout.leftWidth}
        sidebarToggleLabel={
          adaptiveLayout.leftOverlay
            ? leftOverlayOpen
              ? "Close sidebar"
              : "Show sidebar"
            : undefined
        }
        contextSidebarCollapsed={!rightRailActive}
        contextSidebarToggleLabel={
          adaptiveLayout.rightOverlay
            ? rightOverlayOpen
              ? "Close context"
              : "Show context"
            : undefined
        }
        onToggleContextSidebar={toggleAdaptiveContextSidebar}
        onPopOutQuickChat={
          quickChatPopOutThreadId
            ? () => void showQuickChatWindow({ threadId: quickChatPopOutThreadId })
            : undefined
        }
        title={topBarTitle}
        subtitle={adaptiveLayout.tier === "full" ? topBarSubtitle : null}
        compactToolbar={adaptiveLayout.tier !== "full"}
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
          showContextSidebar &&
          (!showCanvasInTopBar || adaptiveLayout.rightOverlay) &&
          workspaceStartupProgress === null
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
      {preserveCachedContentOnStartupError && startupError ? (
        <StartupRecovery
          detail={startupError}
          init={init}
          retrying={bootstrapLoading}
          presentation="banner"
        />
      ) : ready && bootstrapLoading ? (
        <div
          role="status"
          data-slot="startup-progress-banner"
          className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-background/85 px-4 py-2 text-xs text-muted-foreground"
        >
          <Spinner className="size-3.5" aria-hidden="true" />
          <span>
            {startupPresentation.title}. {startupPresentation.detail}
          </span>
        </div>
      ) : null}
      {!startupError && !bootstrapLoading && selectedThreadId ? (
        <ConnectionRecoveryBanner
          disconnected={showReconnectBanner}
          operation={reconnectOperation}
          reconnect={() => reconnectThreadWithFeedback(selectedThreadId)}
        />
      ) : null}
      <div className="app-chat-body relative flex min-h-0 min-w-0 flex-1 flex-row">
        <LeftSidebarPane
          active={leftRailActive}
          maximumWidth={Math.max(160, adaptiveLayout.leftMaximumWidth)}
          onClose={() => setLeftOverlayOpen(false)}
          overlay={adaptiveLayout.leftOverlay}
          width={leftRailWidth}
        />
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
            <div
              className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
              data-slot="primary-content-pane"
            >
              <PrimaryContent
                init={init}
                ready={ready}
                bootstrapLoading={bootstrapLoading}
                bootstrapStage={bootstrapStage}
                startupError={preserveCachedContentOnStartupError ? null : startupError}
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
              <RightSidebarPane
                active={rightRailActive}
                maximumWidth={Math.max(
                  rightRailSizing.minimumWidth,
                  adaptiveLayout.rightMaximumWidth,
                )}
                minimumWidth={rightRailSizing.minimumWidth}
                onClose={() => setRightOverlayOpen(false)}
                overlay={adaptiveLayout.rightOverlay}
                width={rightRailWidth}
              />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
});

function AppContent() {
  const windowMode = getDesktopWindowMode();
  const canvasWindowPath =
    windowMode === "canvas" ? new URLSearchParams(window.location.search).get("path") || "" : "";
  const canvasSurfaceKind = getCanvasSurfaceKind(canvasWindowPath);
  const { hasOpenOverlay } = useOverlayStack();
  const ready = useAppStore((s) => s.ready);
  const bootstrapPhase = useAppStore((s) => s.bootstrapPhase);
  const bootstrapStage = useAppStore((s) => s.bootstrapStage);
  const startupError = useAppStore((s) => s.startupError);
  const init = useAppStore((s) => s.init);
  const invalidateBootstrap = useAppStore((s) => s.invalidateBootstrap);
  const view = useAppStore((s) => s.view);
  const filePreviewPath = useAppStore((s) => s.filePreview?.path ?? null);
  const canvasEnabled = useAppStore((s) => s.desktopFeatureFlags?.canvas === true);
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

  useEffect(
    () =>
      onWindowCloseRequested((request) => {
        void (async () => {
          let canClose = false;
          try {
            canClose = await requestCanvasDocumentTransition(null);
          } catch {
            canClose = false;
          } finally {
            await resolveWindowCloseRequest({
              requestId: request.requestId,
              canClose,
            }).catch(() => {});
          }
        })();
      }),
    [],
  );

  useEffect(() => {
    const documentElement = document.documentElement;
    documentElement.dataset.windowMode = windowMode;
    if (windowMode === "canvas") {
      documentElement.dataset.canvasSurface = canvasSurfaceKind;
    }
    return () => {
      delete documentElement.dataset.windowMode;
      delete documentElement.dataset.canvasSurface;
    };
  }, [canvasSurfaceKind, windowMode]);

  useEffect(() => {
    if (view !== "settings") return;
    return onDesktopRailCommand((command) => {
      if (command === "toggle-sidebar") {
        useAppStore.getState().toggleSidebar();
      }
    });
  }, [view]);

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
        if (event.defaultPrevented || event.isComposing || hasOpenOverlay()) return;
        if (isEditableEscapeTarget(event.target)) return;
        const state = useAppStore.getState();
        if (state.view === "settings") {
          event.preventDefault();
          state.closeSettings();
        }
        return;
      }

      if (isStopTurnShortcut(event)) {
        if (event.defaultPrevented || event.isComposing || hasOpenOverlay()) return;
        const state = useAppStore.getState();
        if (!state.selectedThreadId || !state.threadRuntimeById[state.selectedThreadId]?.busy) {
          return;
        }
        event.preventDefault();
        state.cancelThread(state.selectedThreadId);
      }
    }

    windowTarget.addEventListener("keydown", handleKeyDown);
    return () => windowTarget.removeEventListener("keydown", handleKeyDown);
  }, [hasOpenOverlay]);

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
        requestDesktopRailCommand("toggle-sidebar");
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
    return onPreviewFileChanged((event) => {
      workspaceFileChangeEvents.publish(event);
    });
  }, []);

  useEffect(() => {
    return onUpdateStateChanged(setUpdateState);
  }, [setUpdateState]);

  useEffect(() => {
    function applySystemAppearance(appearance: SystemAppearance): void {
      applySystemAppearanceToDocument(appearance, document, localStorage);
      syncPlatformChromeCssVars(document);
    }

    const unsubscribe = onSystemAppearanceChanged(applySystemAppearance);
    void getSystemAppearance()
      .then(applySystemAppearance)
      .catch(() => {
        // Keep CSS media-query fallback when system appearance cannot be loaded.
      });
    void setWindowAppearance({
      themeSource: readBootstrappedThemeSource(document.documentElement),
    }).catch(() => {
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
      const appIsForegrounded = document.visibilityState === "visible" && document.hasFocus();
      if (notification.audience !== "background" || appIsForegrounded) {
        continue;
      }
      void showNotification({
        title: notification.title,
        body: notification.detail,
      }).catch(() => {
        // The in-app notification remains available; OS delivery is best effort.
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
          className="relative flex h-full w-full flex-col bg-canvas text-canvas-foreground"
          data-canvas-surface={canvasSurfaceKind}
        >
          <div className="flex-1 min-h-0 min-w-0">
            <InlineErrorBoundary label="This canvas couldn't be rendered.">
              <Canvas path={canvasWindowPath} />
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
          bootstrapStage={bootstrapStage}
        />
      )}
      <LmStudioStartDialog />
      {windowMode === "main" &&
      !(canvasEnabled && filePreviewPath && isCanvasSupportedFile(filePreviewPath)) ? (
        <FilePreviewModal />
      ) : null}
      {windowMode === "main" ? (
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      ) : null}
      {windowMode === "main" ? <DesktopOnboarding /> : null}
      {windowMode === "main" ? <TranscriptDeliveryRecovery /> : null}
      {windowMode === "main" ? <InAppToasts /> : null}
    </>
  );
}

export default function App() {
  return (
    <OverlayStackProvider>
      <AppContent />
    </OverlayStackProvider>
  );
}
