import { Outlet } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigationSnapshot } from "../../app/navigation";
import { useAppStore } from "../../app/store";
import type { BootstrapStage } from "../../app/store.helpers";
import { operationKey } from "../../app/store.helpers/operations";
import { isOneOffChatWorkspace } from "../../app/types";
import { Spinner } from "../../components/ui/spinner";
import { resolveRightRailSizing } from "../../lib/adaptiveLayout";
import { showCanvasWindow, showQuickChatWindow } from "../../lib/desktopCommands";
import { onDesktopRailCommand } from "../../lib/desktopRailCommands";
import { getFilePreviewKind, isCanvasSupportedFile } from "../../lib/filePreviewKind";
import { canPopOutQuickChatThread } from "../../lib/quickChatPopout";
import { useAdaptiveLayout } from "../../lib/useAdaptiveLayout";
import { cn } from "../../lib/utils";
import { Canvas } from "../Canvas";
import { ConnectionRecoveryBanner } from "../ConnectionRecoveryBanner";
import { ContextSidebar } from "../ContextSidebar";
import { InlineErrorBoundary } from "../CrashReportingErrorBoundary";
import { shouldShowReconnectBanner } from "../chat/chatLogic";
import { FilePreviewModal } from "../FilePreviewModal";
import { StartupRecovery } from "../recovery/StartupRecovery";
import { startupStagePresentation } from "../recovery/startupPresentation";
import { Sidebar } from "../Sidebar";
import { TaskContextSidebar } from "../tasks/TaskContextSidebar";
import { AdaptiveRailSurface } from "./AdaptiveRailSurface";
import { AppTopBar } from "./AppTopBar";
import { ContextSidebarResizer } from "./ContextSidebarResizer";
import { PrimaryContent } from "./PrimaryContent";
import { SidebarResizer } from "./SidebarResizer";

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
  const view = useNavigationSnapshot().view;

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
  const view = useNavigationSnapshot().view;
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
  const showInlineFilePreview =
    isConversationView && canvasPath !== null && !(canvasEnabled && canvasSupported);
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
    rightSidebarOverlayAllowed: rightRailKind !== "context",
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
      const nextOpen = !leftOverlayOpen;
      setLeftOverlayOpen(nextOpen);
      if (nextOpen) setRightOverlayOpen(false);
      return;
    }
    toggleSidebar();
  }, [adaptiveLayout.leftOverlay, leftOverlayOpen, toggleSidebar]);
  const toggleAdaptiveContextSidebar = useCallback(() => {
    if (adaptiveLayout.rightOverlay) {
      const nextOpen = !rightOverlayOpen;
      setRightOverlayOpen(nextOpen);
      if (nextOpen) setLeftOverlayOpen(false);
      return;
    }
    toggleContextSidebar();
  }, [adaptiveLayout.rightOverlay, rightOverlayOpen, toggleContextSidebar]);
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
    effectiveView === "task"
      ? (selectedTask?.title ?? "New task")
      : activeThread?.title?.trim() || "New chat";
  const topBarSubtitle: string | null = isOneOffChatWorkspace(activeWorkspace)
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
  const showCanvasInTopBar = showCanvasSurface;
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
  const previousRightOverlayRef = useRef(false);
  const canvasOpenedRightOverlayRef = useRef(false);
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
    const enteredRightOverlay = adaptiveLayout.rightOverlay && !previousRightOverlayRef.current;
    previousCanvasPathRef.current = activeCanvasPath;
    previousRightOverlayRef.current = adaptiveLayout.rightOverlay;
    if (previousCanvasPath !== null && activeCanvasPath === null) {
      if (adaptiveLayout.rightOverlay && canvasOpenedRightOverlayRef.current) {
        setRightOverlayOpen(false);
      }
      canvasOpenedRightOverlayRef.current = false;
      return;
    }
    if (
      adaptiveLayout.rightOverlay &&
      activeCanvasPath !== null &&
      (activeCanvasPath !== previousCanvasPath || enteredRightOverlay)
    ) {
      const openedByCanvas =
        canvasOpenedRightOverlayRef.current ||
        enteredRightOverlay ||
        (previousCanvasPath === null && !rightOverlayOpen);
      canvasOpenedRightOverlayRef.current = openedByCanvas;
      if (openedByCanvas) {
        setLeftOverlayOpen(false);
        setRightOverlayOpen(true);
      }
      return;
    }
    if (
      adaptiveLayout.rightOverlay &&
      activeCanvasPath !== null &&
      !rightOverlayOpen &&
      canvasOpenedRightOverlayRef.current
    ) {
      canvasOpenedRightOverlayRef.current = false;
    }
  }, [activeCanvasPath, adaptiveLayout.rightOverlay, rightOverlayOpen]);

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
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.ownerDocument.getElementById("main-content")?.focus();
        }}
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-md focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </button>
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
        hideThreadShell={isConversationView && activeThread === null}
        sessionUsage={isConversationView ? selectedSessionUsage : null}
        lastTurnUsage={isConversationView ? selectedLastTurnUsage : null}
        agents={isConversationView ? selectedAgents : []}
        canClearHardCap={canClearHardCap}
        onClearHardCap={
          selectedThreadId ? () => clearThreadUsageHardCap(selectedThreadId) : undefined
        }
        showContextToggle={showContextSidebar && workspaceStartupProgress === null}
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
          automaticallyReconnecting={
            activeWorkspaceId
              ? workspaceRuntimeById[activeWorkspaceId]?.reconnecting === true
              : false
          }
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
            effectiveView === "settings" ? "Settings" : effectiveView === "task" ? "Task" : "Chat"
          }
          className="app-main-content flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        >
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div
              className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
              data-slot="primary-content-pane"
            >
              <div
                className={cn(
                  "relative min-h-0 min-w-0 overflow-hidden",
                  showInlineFilePreview
                    ? "w-[38%] min-w-[min(18rem,42%)] shrink-0 border-r app-border-subtle"
                    : "flex-1",
                )}
                data-slot="conversation-content-pane"
              >
                <PrimaryContent
                  init={init}
                  ready={ready}
                  bootstrapLoading={bootstrapLoading}
                  bootstrapStage={bootstrapStage}
                  startupError={preserveCachedContentOnStartupError ? null : startupError}
                  workspaceStartupProgress={workspaceStartupProgress}
                >
                  <Outlet />
                </PrimaryContent>
              </div>
              {showInlineFilePreview ? (
                <div
                  className="min-h-0 min-w-0 flex-1 overflow-hidden"
                  data-slot="file-preview-pane"
                >
                  <FilePreviewModal presentation="inline" />
                </div>
              ) : null}
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

export function ChatScreen() {
  const init = useAppStore((state) => state.init);
  const ready = useAppStore((state) => state.ready);
  const startupError = useAppStore((state) => state.startupError);
  const bootstrapLoading = useAppStore((state) => state.bootstrapPhase === "loading");
  const bootstrapStage = useAppStore((state) => state.bootstrapStage);
  return (
    <ChatShell
      init={init}
      ready={ready}
      startupError={startupError}
      bootstrapLoading={bootstrapLoading}
      bootstrapStage={bootstrapStage}
    />
  );
}
