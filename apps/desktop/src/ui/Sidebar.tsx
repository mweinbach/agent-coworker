import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../app/store";
import { formatThreadTime } from "../lib/time";
import { selectSidebarThreadsForWorkspace } from "./sidebarSelectors";

function NavButton(props: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  const className =
    "navItem" +
    (props.active ? " navItemActive" : "") +
    (props.disabled ? " navItemDisabled" : "");

  return (
    <button className={className} onClick={props.disabled ? undefined : props.onClick} type="button">
      <span className="navDot" aria-hidden="true" />
      <span>{props.label}</span>
    </button>
  );
}

export function Sidebar() {
  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const newThread = useAppStore((s) => s.newThread);
  const removeThread = useAppStore((s) => s.removeThread);
  const selectThread = useAppStore((s) => s.selectThread);
  const openSkills = useAppStore((s) => s.openSkills);
  const openSettings = useAppStore((s) => s.openSettings);
  const archiveThread = useAppStore((s) => s.archiveThread);

  const [ctxMenu, setCtxMenu] = useState<
    | {
        kind: "workspace";
        x: number;
        y: number;
        workspaceId: string;
        workspaceName: string;
        workspacePath: string;
      }
    | {
        kind: "thread";
        x: number;
        y: number;
        threadId: string;
        threadTitle: string;
        workspaceName: string;
      }
    | null
  >(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const onClick = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("blur", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("blur", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const ctxStyle = useMemo(() => {
    if (!ctxMenu) return null;
    const w = 240;
    const h = ctxMenu.kind === "thread" ? 140 : 90;
    const left = Math.max(10, Math.min(ctxMenu.x, window.innerWidth - w - 10));
    const top = Math.max(10, Math.min(ctxMenu.y, window.innerHeight - h - 10));
    return { left, top } as const;
  }, [ctxMenu]);

  return (
    <aside className="sidebar" role="complementary" aria-label="Sidebar navigation">
      <div className="sidebarHeader">
        <div className="brand">
          <div className="brandMark" aria-hidden="true" />
          <div className="brandName">Cowork</div>
        </div>
      </div>

      <nav className="sidebarNav" aria-label="Main navigation">
        <NavButton
          active={view === "chat"}
          label="New thread"
          onClick={() => {
            void newThread();
          }}
        />
        <NavButton active={view === "automations"} label="Automations" disabled />
        <NavButton
          active={view === "skills"}
          label="Skills"
          onClick={() => {
            void openSkills();
          }}
        />
      </nav>

      <div className="sidebarSection" role="region" aria-label="Workspaces">
        <div className="sectionTitleRow">
          <div className="sectionTitle" id="workspaces-label">Workspaces</div>
          <button className="iconButton" type="button" onClick={() => void addWorkspace()} title="Add workspace" aria-label="Add workspace">
            +
          </button>
        </div>

        <div className="workspaceList" role="list" aria-labelledby="workspaces-label">
          {workspaces.length === 0 ? (
            <div style={{ padding: 10, color: "rgba(0,0,0,0.45)" }}>
              Add a workspace to start.
            </div>
          ) : null}

          {workspaces.map((ws) => {
            const active = ws.id === selectedWorkspaceId;
            const rt = workspaceRuntimeById[ws.id];
            const serverPill =
              rt?.starting ? (
                <span className="pill">starting</span>
              ) : rt?.serverUrl ? (
                <span className="pill">ready</span>
              ) : rt?.error ? (
                <span className="pill">error</span>
              ) : null;

            return (
              <div
                key={ws.id}
                role="listitem"
                className={"workspaceRow" + (active ? " workspaceRowActive" : "")}
                onClick={() => void selectWorkspace(ws.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxMenu({
                    kind: "workspace",
                    x: e.clientX,
                    y: e.clientY,
                    workspaceId: ws.id,
                    workspaceName: ws.name,
                    workspacePath: ws.path,
                  });
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div className="workspaceName">{ws.name}</div>
                  {serverPill}
                </div>
                <div className="workspacePath">{ws.path}</div>

                {active ? (
                  <div className="threadList">
                    {selectSidebarThreadsForWorkspace(threads, ws.id).map((t) => {
                      const tr = threadRuntimeById[t.id];
                      const busy = tr?.busy === true;
                      return (
                        <div
                          key={t.id}
                          className={"threadRow" + (t.id === selectedThreadId ? " threadRowActive" : "")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void selectThread(t.id);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCtxMenu({
                              kind: "thread",
                              x: e.clientX,
                              y: e.clientY,
                              threadId: t.id,
                              threadTitle: t.title || "New thread",
                              workspaceName: ws.name,
                            });
                          }}
                        >
                          <div className="threadTitle">
                            <div className="threadTitleMain">{t.title || "New thread"}</div>
                            <div className="threadTitleMeta">
                              {t.status === "active" ? "Active" : "Transcript"} · {formatThreadTime(t.lastMessageAt)}
                            </div>
                          </div>
                          {busy ? <span className="pill pillBusy">busy</span> : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {ctxMenu && ctxStyle ? (
        <div className="ctxMenu" role="menu" aria-label="Context menu" style={ctxStyle} onClick={(e) => e.stopPropagation()}>
          {ctxMenu.kind === "workspace" ? (
            <>
              <div className="ctxMenuTitle" title={ctxMenu.workspacePath}>
                {ctxMenu.workspaceName}
              </div>

              <button
                className="ctxMenuItem ctxMenuItemDanger"
                role="menuitem"
                type="button"
                onClick={() => {
                  const ok = window.confirm(
                    `Remove workspace "${ctxMenu.workspaceName}"? This will remove its threads from the app, but will not delete files on disk.`
                  );
                  if (!ok) return;
                  void removeWorkspace(ctxMenu.workspaceId);
                  setCtxMenu(null);
                }}
              >
                Remove workspace
              </button>
            </>
          ) : (
            <>
              <div className="ctxMenuTitle" title={`Workspace: ${ctxMenu.workspaceName}`}>
                {ctxMenu.threadTitle}
              </div>

              <button
                className="ctxMenuItem"
                role="menuitem"
                type="button"
                onClick={() => {
                  void archiveThread(ctxMenu.threadId);
                  setCtxMenu(null);
                }}
              >
                Archive session
              </button>

              <button
                className="ctxMenuItem ctxMenuItemDanger"
                role="menuitem"
                type="button"
                onClick={() => {
                  const ok = window.confirm(
                    `Remove session "${ctxMenu.threadTitle}"? This will remove it from the app and delete its local transcript.`
                  );
                  if (!ok) return;
                  void removeThread(ctxMenu.threadId);
                  setCtxMenu(null);
                }}
              >
                Remove session
              </button>

              <div className="ctxMenuMuted">Archived sessions are available under Settings → Sessions.</div>
            </>
          )}
        </div>
      ) : null}

      <div style={{ marginTop: "auto" }}>
        <button className={"navItem" + (view === "settings" ? " navItemActive" : "")} type="button" onClick={() => openSettings()}>
          <span className="navDot" aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
