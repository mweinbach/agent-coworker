import { memo, useEffect, useMemo, useRef } from "react";

import { disposeAllJsonRpcState } from "./app/store.helpers";
import { useAppStore } from "./app/store";
import type { DesktopMenuCommand, SystemAppearance } from "./lib/desktopApi";
import {
  getSystemAppearance,
  getUpdateState,
  onMenuCommand,
  onSystemAppearanceChanged,
  onUpdateStateChanged,
  setWindowAppearance,
  showNotification,
} from "./lib/desktopCommands";
import { ASK_SKIP_TOKEN } from "./lib/wsProtocol";
import { ContextSidebar } from "./ui/ContextSidebar";
import { PromptModal } from "./ui/PromptModal";
import { Sidebar } from "./ui/Sidebar";
import { AppTopBar } from "./ui/layout/AppTopBar";
import { ContextSidebarResizer } from "./ui/layout/ContextSidebarResizer";
import { PrimaryContent } from "./ui/layout/PrimaryContent";
import { SettingsContent } from "./ui/layout/SettingsContent";
import { SidebarResizer } from "./ui/layout/SidebarResizer";
import { DesktopOnboarding } from "./ui/onboarding/DesktopOnboarding";

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

  return (
    <div
      className="app-right-sidebar-pane relative shrink-0 overflow-hidden"
      style={{ width: collapsed ? 0 : contextSidebarWidth }}
    >
      {!collapsed ? <ContextSidebarResizer /> : null}
      <div className="absolute top-0 bottom-0 left-0 flex" style={{ width: contextSidebarWidth }}>
        <ContextSidebar />
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
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const newThread = useAppStore((s) => s.newThread);
  const clearThreadUsageHardCap = useAppStore((s) => s.clearThreadUsageHardCap);
  const contextSidebarCollapsed = useAppStore((s) => s.contextSidebarCollapsed);
  const toggleContextSidebar = useAppStore((s) => s.toggleContextSidebar);
  const hasAnimatedSidebarsRef = useRef(false);

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
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const runtime = selectedThreadId ? threadRuntimeById[selectedThreadId] : null;
  const busy = runtime?.busy === true;
  const showContextSidebar = view === "chat" && activeThread !== null;
  const topBarTitle = view === "skills"
    ? "Skills"
    : activeThread?.title?.trim() || "New thread";
  const topBarSubtitle = view === "skills"
    ? selectedWorkspace?.name ?? "Cowork"
    : activeWorkspace?.name ?? "Cowork";
  const canClearHardCap = runtime?.sessionUsage?.budgetStatus.stopTriggered === true
    && runtime?.transcriptOnly !== true
    && runtime?.connected === true
    && Boolean(runtime?.sessionId)
    && activeThread?.status === "active";

  useEffect(() => {
    if (!hasAnimatedSidebarsRef.current) {
      hasAnimatedSidebarsRef.current = true;
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
  }, [sidebarCollapsed, contextSidebarCollapsed]);

  return (
    <div className="app-shell app-shell--chat flex h-full min-h-0 flex-col text-foreground">
      <div className="app-window-drag-strip" aria-hidden="true" />
      <AppTopBar
        busy={view === "chat" ? busy : false}
        onToggleSidebar={toggleSidebar}
        onNewChat={() => void newThread()}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={sidebarWidth}
        contextSidebarCollapsed={contextSidebarCollapsed}
        onToggleContextSidebar={toggleContextSidebar}
        title={topBarTitle}
        subtitle={topBarSubtitle}
        sessionUsage={view === "chat" ? (runtime?.sessionUsage ?? null) : null}
        lastTurnUsage={view === "chat" ? (runtime?.lastTurnUsage ?? null) : null}
        canClearHardCap={canClearHardCap}
        onClearHardCap={selectedThreadId ? () => clearThreadUsageHardCap(selectedThreadId) : undefined}
        showContextToggle={view === "chat"}
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
                view={view === "skills" ? "skills" : "chat"}
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
  const ready = useAppStore((s) => s.ready);
  const bootstrapPending = useAppStore((s) => s.bootstrapPending);
  const startupError = useAppStore((s) => s.startupError);
  const init = useAppStore((s) => s.init);
  const view = useAppStore((s) => s.view);
  const notifications = useAppStore((s) => s.notifications);
  const setUpdateState = useAppStore((s) => s.setUpdateState);
  const seenNotificationIds = useRef(new Set<string>());

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
        void state.newThread();
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
      if (command === "openSkills") {
        void state.openSkills();
      }
    }

    const unsubscribe = onMenuCommand(handleMenuCommand);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = onUpdateStateChanged(setUpdateState);
    void getUpdateState().then(setUpdateState).catch(() => {
      // Keep the default disabled/idle state if the updater bridge is unavailable.
    });
    return unsubscribe;
  }, [setUpdateState]);

  useEffect(() => {
    function applySystemAppearance(appearance: SystemAppearance): void {
      const root = document.documentElement;
      const theme = appearance.shouldUseDarkColors ? "dark" : "light";
      root.dataset.systemTheme = theme;
      root.dataset.systemUiTheme = appearance.shouldUseDarkColorsForSystemIntegratedUI ? "dark" : "light";
      root.dataset.theme = theme;
      root.dataset.platform = appearance.platform;
      root.dataset.highContrast = appearance.shouldUseHighContrastColors || appearance.inForcedColorsMode ? "true" : "false";
      root.dataset.reducedTransparency = appearance.prefersReducedTransparency ? "true" : "false";
      root.style.colorScheme = theme;
      root.classList.toggle("dark", theme === "dark");
      root.classList.toggle("light", theme !== "dark");
    }

    const unsubscribe = onSystemAppearanceChanged(applySystemAppearance);
    void getSystemAppearance().then(applySystemAppearance).catch(() => {
      // Keep CSS media-query fallback when system appearance cannot be loaded.
    });
    void setWindowAppearance({ themeSource: "system" }).catch(() => {
      // Ignore and continue with default system theme behavior.
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
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
  }, [notifications]);

  return (
    <>
      {view === "settings" ? (
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
      <DesktopOnboarding />
    </>
  );
}
