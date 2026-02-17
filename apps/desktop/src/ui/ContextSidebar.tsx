import { useEffect } from "react";
import { useAppStore } from "../app/store";

const IconFile = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
    <polyline points="13 2 13 9 20 9"></polyline>
  </svg>
);

const IconFolder = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>
);

export function ContextSidebar() {
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const todos = useAppStore((s) => selectedThreadId ? s.latestTodosByThreadId[selectedThreadId] : null);
  const files = useAppStore((s) => selectedWorkspaceId ? s.workspaceFilesById[selectedWorkspaceId] : null);
  const refresh = useAppStore((s) => s.refreshWorkspaceFiles);

  useEffect(() => {
    if (selectedWorkspaceId) {
      void refresh(selectedWorkspaceId).catch(() => {});
    }
  }, [selectedWorkspaceId]);

  return (
    <aside className="contextSidebar">
      <div className="contextSection">
        <div className="contextSectionHeader">Tasks</div>
        {!todos || todos.length === 0 ? (
          <div className="contextEmpty">No active tasks</div>
        ) : (
          <div className="contextTodoList">
            {todos.map((t, i) => (
              <div key={i} className="contextTodoItem">
                <span className={`todoStatus ${t.status}`}>
                  {t.status === "completed" ? "✓" : t.status === "in_progress" ? "►" : "○"}
                </span>
                <span className={`todoContent ${t.status}`}>{t.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="contextSection" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div className="contextSectionHeader">Files</div>
        <div className="contextFileList">
          {!files || files.length === 0 ? (
            <div className="contextEmpty">No files found</div>
          ) : (
            files.map((f, i) => (
              <div key={i} className="contextFileItem" title={f.name}>
                {f.isDirectory ? <IconFolder /> : <IconFile />}
                <span className="contextFileName">{f.name}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}
