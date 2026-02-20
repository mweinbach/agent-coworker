import { memo, useEffect, useMemo, useRef } from "react";

import { useAppStore } from "./app/store";
import type { DesktopMenuCommand, SystemAppearance } from "./lib/desktopApi";
import {
  getSystemAppearance,
  onMenuCommand,
  onSystemAppearanceChanged,
  setWindowAppearance,
  showNotification,
} from "./lib/desktopCommands";
import { ContextSidebar } from "./ui/ContextSidebar";
import { PromptModal } from "./ui/PromptModal";
import { Sidebar } from "./ui/Sidebar";
import { AppTopBar } from "./ui/layout/AppTopBar";
import { PrimaryContent } from "./ui/layout/PrimaryContent";
import { SettingsContent } from "./ui/layout/SettingsContent";
import { SidebarResizer } from "./ui/layout/SidebarResizer";
import { ContextSidebarResizer } from "./ui/layout/ContextSidebarResizer";

const LeftSidebarPane = memo(function LeftSidebarPane({ collapsed }: { collapsed: boolean }) {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);

  return (
    <div
      className="app-left-sidebar-pane relative shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] bg-sidebar/85 backdrop-blur-xl border-r border-border/80"
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
      className="app-right-sidebar-pane relative shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] bg-panel border-l border-border/80"
      style={{ width: collapsed ? 0 : contextSidebarWidth, borderLeftWidth: collapsed ? 0 : 1 }}
    >
      {!collapsed ? <ContextSidebarResizer /> : null}
      <div className="absolute top-0 bottom-0 left-0 flex" style={{ width: contextSidebarWidth }}>
        <ContextSidebar />
      </div>
    </div>
  );
});

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const startupError = useAppStore((s) => s.startupError);
  const init = useAppStore((s) => s.init);

  const view = useAppStore((s) => s.view);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const contextSidebarCollapsed = useAppStore((s) => s.contextSidebarCollapsed);
  const toggleContextSidebar = useAppStore((s) => s.toggleContextSidebar);
  const openSkills = useAppStore((s) => s.openSkills);
  const openSettings = useAppStore((s) => s.openSettings);
  const notifications = useAppStore((s) => s.notifications);

  const newThread = useAppStore((s) => s.newThread);
  const seenNotificationIds = useRef(new Set<string>());

  useEffect(() => {
    if (ready) return;
    void init().catch((err) => {
      console.error(err);
    });
  }, [init, ready]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const state = useAppStore.getState();
        if (state.promptModal) {
          // For ask modals, send a response so the server-side deferred promise
          // resolves instead of hanging forever.
          if (state.promptModal.kind === "ask") {
            state.answerAsk(
              state.promptModal.threadId,
              state.promptModal.prompt.requestId,
              "[skipped]",
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
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    function handleMenuCommand(command: DesktopMenuCommand): void {
      if (command === "newThread") {
        void newThread();
        return;
      }
      if (command === "toggleSidebar") {
        toggleSidebar();
        return;
      }
      if (command === "openSettings") {
        openSettings();
        return;
      }
      if (command === "openWorkspacesSettings") {
        openSettings("workspaces");
        return;
      }
      if (command === "openSkills") {
        void openSkills();
      }
    }

    const unsubscribe = onMenuCommand(handleMenuCommand);
    return unsubscribe;
  }, [newThread, openSettings, openSkills, toggleSidebar]);

  useEffect(() => {
    function applySystemAppearance(appearance: SystemAppearance): void {
      const root = document.documentElement;
      root.dataset.systemTheme = appearance.shouldUseDarkColors ? "dark" : "light";
      root.dataset.platform = appearance.platform;
      root.dataset.highContrast = appearance.shouldUseHighContrastColors || appearance.inForcedColorsMode ? "true" : "false";
      root.dataset.reducedTransparency = appearance.prefersReducedTransparency ? "true" : "false";
      root.style.colorScheme = appearance.shouldUseDarkColors ? "dark" : "light";
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

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const runtime = selectedThreadId ? threadRuntimeById[selectedThreadId] : null;
  const busy = runtime?.busy === true;
  const showContextSidebar = view === "chat" && activeThread !== null;


  if (view === "settings") {
    return (
      <div className="app-shell flex h-full min-h-0 flex-col bg-background text-foreground">
        <div className="app-window-drag-strip" aria-hidden="true" />
        <div className="min-h-0 flex-1">
          <SettingsContent init={init} ready={ready} startupError={startupError} />
        </div>
        <PromptModal />
      </div>
    );
  }

  return (
    <div className="app-shell h-full flex flex-col bg-background text-foreground">
      <div className="app-window-drag-strip" aria-hidden="true" />
      <AppTopBar
        busy={busy}
        onToggleSidebar={toggleSidebar}
        sidebarCollapsed={sidebarCollapsed}
        contextSidebarCollapsed={contextSidebarCollapsed}
        onToggleContextSidebar={toggleContextSidebar}
      />
      <div className="flex min-h-0 flex-1">
        <LeftSidebarPane collapsed={sidebarCollapsed} />

        <main className="flex min-w-0 flex-1 flex-col bg-panel">
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 flex-1 overflow-hidden relative">
              <PrimaryContent init={init} ready={ready} startupError={startupError} view={view} />
            </div>
            {showContextSidebar ? (
              <RightSidebarPane collapsed={contextSidebarCollapsed} />
            ) : null}
          </div>
        </main>
      </div>

      <PromptModal />
    </div>
  );
}
