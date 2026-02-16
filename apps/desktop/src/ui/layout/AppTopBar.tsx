interface AppTopBarProps {
  busy: boolean;
  onCreateThread: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  title: string;
  view: "chat" | "skills";
}

export function AppTopBar({
  busy,
  onCreateThread,
  onToggleSidebar,
  sidebarCollapsed,
  title,
  view,
}: AppTopBarProps) {
  return (
    <div className="topbar">
      <div className="topbarLeft">
        <button
          className="sidebarToggle"
          type="button"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
        >
          ☰
        </button>
        <div className="topbarTitle">{title}</div>
      </div>
      <div className="topbarRight">
        {busy && <span className="pill pillBusy">busy</span>}
        {view === "chat" && (
          <button className="iconButton" type="button" onClick={onCreateThread}>
            New
          </button>
        )}
      </div>
    </div>
  );
}
