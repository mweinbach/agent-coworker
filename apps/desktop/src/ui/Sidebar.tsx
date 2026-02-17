import { useAppStore } from "../app/store";
import { showContextMenu } from "../lib/desktopCommands";

const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

const IconMessage = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
  </svg>
);

const IconPlusCircle = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="12" y1="8" x2="12" y2="16"></line>
    <line x1="8" y1="12" x2="16" y2="12"></line>
  </svg>
);

const IconZap = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
  </svg>
);

const IconFolder = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>
);

const IconSettings = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
);

export function Sidebar() {
  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const newThread = useAppStore((s) => s.newThread);
  const removeThread = useAppStore((s) => s.removeThread);
  const selectThread = useAppStore((s) => s.selectThread);
  const openSkills = useAppStore((s) => s.openSkills);
  const openSettings = useAppStore((s) => s.openSettings);

  const activeWorkspaceThreads = (selectedWorkspaceId
    ? threads.filter((t) => t.workspaceId === selectedWorkspaceId)
    : []
  ).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));

  const handleWorkspaceContextMenu = async (e: React.MouseEvent, wsId: string, wsName: string) => {
    e.preventDefault();
    e.stopPropagation();

    const result = await showContextMenu([
      { id: "select", label: "Select workspace" },
      { id: "remove", label: "Remove workspace" },
    ]);

    if (result === "select") {
      void selectWorkspace(wsId);
    } else if (result === "remove") {
      if (window.confirm(`Remove workspace "${wsName}"?`)) {
        void removeWorkspace(wsId);
      }
    }
  };

  const handleThreadContextMenu = async (e: React.MouseEvent, tId: string, tTitle: string) => {
    e.preventDefault();
    e.stopPropagation();

    const result = await showContextMenu([
      { id: "select", label: "Open thread" },
      { id: "remove", label: "Remove thread" },
    ]);

    if (result === "select") {
      void selectThread(tId);
    } else if (result === "remove") {
      if (window.confirm(`Remove session "${tTitle}"?`)) {
        void removeThread(tId);
      }
    }
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brandMark" />
        <div className="brandName">Cowork</div>
      </div>

      <nav className="sidebarNav">
        <button
          className="navItem"
          data-active={view === "chat"}
          onClick={() => void newThread()}
        >
          <IconPlusCircle />
          <span>New thread</span>
        </button>

        <button
          className="navItem"
          data-active={view === "skills"}
          onClick={() => void openSkills()}
        >
          <IconZap />
          <span>Skills</span>
        </button>
      </nav>

      <div className="sidebarSection">
        <div className="sectionTitleRow">
          <div className="sectionTitle">Workspaces</div>
          <button
            className="sidebarToggle"
            type="button"
            onClick={() => void addWorkspace()}
            title="Add workspace"
          >
            <IconPlus />
          </button>
        </div>

        <div className="workspaceList">
          {workspaces.length === 0 ? (
            <div className="workspaceEmpty">
              <div>No workspaces yet</div>
              <button className="iconButton" type="button" onClick={() => void addWorkspace()} style={{ marginTop: 10 }}>
                Add workspace
              </button>
            </div>
          ) : (
            workspaces.map((ws) => {
              const active = ws.id === selectedWorkspaceId;
              const workspaceThreads = active ? activeWorkspaceThreads : [];

              return (
                <div key={ws.id}>
                  <div
                    className="workspaceRow"
                    data-active={active}
                    onClick={() => void selectWorkspace(ws.id)}
                    onContextMenu={(e) => handleWorkspaceContextMenu(e, ws.id, ws.name)}
                    title={ws.path}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <IconFolder />
                      <div className="workspaceName">{ws.name}</div>
                    </div>
                    <div className="workspacePath">{ws.path}</div>
                  </div>

                  {active && (
                    <div className="workspaceSessions">
                      {workspaceThreads.length === 0 ? (
                        <div className="workspaceSessionsEmpty">No sessions yet</div>
                      ) : (
                        workspaceThreads.map((t) => {
                          const tr = threadRuntimeById[t.id];
                          const busy = tr?.busy === true;
                          const isActive = t.id === selectedThreadId;

                          return (
                            <div
                              key={t.id}
                              className="threadRow"
                              data-active={isActive}
                              role="button"
                              tabIndex={0}
                              onClick={() => void selectThread(t.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  void selectThread(t.id);
                                }
                              }}
                              onContextMenu={(e) => handleThreadContextMenu(e, t.id, t.title || "New thread")}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                                <IconMessage />
                                <div className="threadTitleMain">{t.title || "New thread"}</div>
                              </div>
                              {busy && <span className="threadBusyDot" />}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ marginTop: "auto" }}>
        <button
          className="navItem"
          data-active={view === "settings"}
          type="button"
          onClick={() => openSettings()}
        >
          <IconSettings />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
