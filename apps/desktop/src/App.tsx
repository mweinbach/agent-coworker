import { useEffect, useMemo, useRef } from "react";

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

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const startupError = useAppStore((s) => s.startupError);
  const init = useAppStore((s) => s.init);

  const view = useAppStore((s) => s.view);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
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

  const title = view === "skills" ? "Skills" : activeThread?.title || "New thread";

  if (view === "settings") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <div className="min-h-0 flex-1">
          <SettingsContent init={init} ready={ready} startupError={startupError} />
        </div>
        <PromptModal />
      </div>
    );
  }

  return (
    <div className="h-full bg-background text-foreground">
      <div className="flex h-full min-h-0">
        <div
          className="relative shrink-0 overflow-hidden"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          {!sidebarCollapsed ? <Sidebar /> : null}
          {!sidebarCollapsed ? <SidebarResizer /> : null}
        </div>

        <main className="flex min-w-0 flex-1 flex-col bg-panel">
          <AppTopBar
            busy={busy}
            onCreateThread={() => void newThread()}
            onToggleSidebar={toggleSidebar}
            sidebarCollapsed={sidebarCollapsed}
            title={title}
            view={view}
          />

          <div className="min-h-0 flex-1 overflow-hidden">
            <PrimaryContent init={init} ready={ready} startupError={startupError} view={view} />
          </div>
        </main>

        {showContextSidebar ? <ContextSidebar /> : null}
      </div>

      <PromptModal />
    </div>
  );
}
