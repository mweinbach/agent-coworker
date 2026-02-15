import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "./app/store";
import type { ProviderName } from "./lib/wsProtocol";
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "./lib/modelChoices";
import { defaultModelForProvider } from "@cowork/providers/catalog";

import { Sidebar } from "./ui/Sidebar";
import { ChatView } from "./ui/ChatView";
import { SkillsView } from "./ui/SkillsView";
import { SettingsShell } from "./ui/settings/SettingsShell";
import { PromptModal } from "./ui/PromptModal";
import { TitleBar } from "./ui/TitleBar";

function SidebarResizer() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);

  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;
    setDragging(true);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current;
      setSidebarWidth(startWidthRef.current + delta);
    };

    const handleMouseUp = () => {
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, setSidebarWidth]);

  return (
    <div
      className={"sidebarResizer" + (dragging ? " sidebarResizerActive" : "")}
      onMouseDown={handleMouseDown}
    />
  );
}

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const startupError = useAppStore((s) => s.startupError);
  const init = useAppStore((s) => s.init);

  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
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
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        void newThread();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      if (e.key === "Escape") {
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
          const rt = state.threadRuntimeById[state.selectedThreadId];
          if (rt?.busy) {
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
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [selectedThreadId, threads]
  );
  const activeWorkspaceId = activeThread?.workspaceId ?? selectedWorkspaceId;
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces]
  );

  const rt = activeThread ? threadRuntimeById[activeThread.id] : null;
  const busy = rt?.busy === true;

  const provider = (activeWorkspace?.defaultProvider ?? "google") as ProviderName;
  const model = activeWorkspace?.defaultModel ?? "";

  const title = view === "skills" ? "Skills" : activeThread?.title || "New thread";

  if (view === "settings") {
    return (
      <div className="settingsRoot">
        <TitleBar />
        <div className="appContent">
          {!ready ? (
            <div className="hero">
              <div className="heroTitle">Starting…</div>
            </div>
          ) : (
            <>
              {startupError ? (
                <div style={{ margin: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6, background: "var(--danger-bg)" }}>
                  <div>Running with fresh state due to an error.</div>
                  <button className="iconButton" type="button" onClick={() => void init()} style={{ marginTop: 8 }}>
                    Retry
                  </button>
                </div>
              ) : null}
              <SettingsShell />
            </>
          )}
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
          <div className="topbar">
            <div className="topbarLeft">
              <button
                className="sidebarToggle"
                type="button"
                onClick={toggleSidebar}
                title={sidebarCollapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
              >
                {sidebarCollapsed ? "☰" : "☰"}
              </button>
              <div className="topbarTitle">{title}</div>
            </div>
            <div className="topbarRight">
              {busy && <span className="pill pillBusy">busy</span>}
              {view === "chat" && (
                <button className="iconButton" type="button" onClick={() => void newThread()}>
                  New
                </button>
              )}
            </div>
          </div>

          <div className="content">
            {!ready ? (
              <div className="hero">
                <div className="heroTitle">Starting…</div>
              </div>
            ) : startupError ? (
              <div className="hero">
                <div className="heroTitle">Recovered</div>
                <div className="heroSub">{startupError}</div>
                <button className="iconButton" type="button" onClick={() => void init()}>
                  Retry
                </button>
              </div>
            ) : view === "skills" ? (
              <SkillsView />
            ) : (
              <ChatView />
            )}
          </div>
        </main>
      </div>

      <PromptModal />
    </div>
  );
}