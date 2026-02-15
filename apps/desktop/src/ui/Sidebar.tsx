import { useAppStore } from "../app/store";
import { showContextMenu } from "../lib/desktopCommands";

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
          <span className="navDot" />
          <span>New thread</span>
        </button>

        <button
          className="navItem"
          data-active={view === "skills"}
          onClick={() => void openSkills()}
        >
          <span className="navDot" />
          <span>Skills</span>
        </button>
      </nav>

      <div className="sidebarSection">
        <div className="sectionTitleRow">
          <div className="sectionTitle">Workspaces</div>
          <button
            className="iconButton"
            type="button"
            onClick={() => void addWorkspace()}
            title="Add workspace"
          >
            +
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
                    <div className="workspaceName">{ws.name}</div>
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
                              <div className="threadTitleMain">{t.title || "New thread"}</div>
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
          <span className="navDot" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
