import { useEffect, useMemo } from "react";

import { useAppStore } from "./app/store";
import { PromptModal } from "./ui/PromptModal";
import { Sidebar } from "./ui/Sidebar";
import { ContextSidebar } from "./ui/ContextSidebar";
import { TitleBar } from "./ui/TitleBar";
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

  const newThread = useAppStore((s) => s.newThread);

  useEffect(() => {
    if (ready) return;
    void init().catch((err) => {
      console.error(err);
    });
  }, [init, ready]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "n") {
        event.preventDefault();
        void newThread();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }

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
  }, [newThread, toggleSidebar]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const runtime = selectedThreadId ? threadRuntimeById[selectedThreadId] : null;
  const busy = runtime?.busy === true;

  const title = view === "skills" ? "Skills" : activeThread?.title || "New thread";

  if (view === "settings") {
    return (
      <div className="settingsRoot">
        <TitleBar />
        <div className="appContent">
          <SettingsContent init={init} ready={ready} startupError={startupError} />
        </div>
        <PromptModal />
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="appContent">
        <div
          className={"sidebarContainer" + (sidebarCollapsed ? " sidebarCollapsed" : "")}
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          {!sidebarCollapsed && <Sidebar />}
          {!sidebarCollapsed && <SidebarResizer />}
        </div>

        <main className="main">
          <AppTopBar
            busy={busy}
            onCreateThread={() => void newThread()}
            onToggleSidebar={toggleSidebar}
            sidebarCollapsed={sidebarCollapsed}
            title={title}
            view={view}
          />

          <div className="content">
            <PrimaryContent init={init} ready={ready} startupError={startupError} view={view} />
          </div>
        </main>

        <ContextSidebar />
      </div>

      <PromptModal />
    </div>
  );
}
