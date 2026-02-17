interface AppTopBarProps {
  busy: boolean;
  onCreateThread: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  title: string;
  view: "chat" | "skills";
}

const IconSidebar = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="9" y1="3" x2="9" y2="21"></line>
  </svg>
);

const IconPlus = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

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
          <IconSidebar />
        </button>
        <div className="topbarTitle">{title}</div>
      </div>
      <div className="topbarRight">
        {busy && (
          <div className="statusPill busy">
            <div className="spinner-mini" />
            <span>Busy</span>
          </div>
        )}
        {view === "chat" && (
          <button className="primaryButton" type="button" onClick={onCreateThread}>
            <IconPlus />
            <span>New</span>
          </button>
        )}
      </div>
    </div>
  );
}
