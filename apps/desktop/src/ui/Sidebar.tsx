import { Fragment, useEffect, useMemo, useState } from "react";

import { useAppStore } from "../app/store";
import { formatRelativeAge } from "../lib/time";
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
  const openCheckpointsModal = useAppStore((s) => s.openCheckpointsModal);
  const checkpointThread = useAppStore((s) => s.checkpointThread);

  const [sessionLimitByWorkspaceId, setSessionLimitByWorkspaceId] = useState<Record<string, number>>({});

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

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    setSessionLimitByWorkspaceId((s) => (s[selectedWorkspaceId] ? s : { ...s, [selectedWorkspaceId]: 12 }));
  }, [selectedWorkspaceId]);

  const ctxStyle = useMemo(() => {
    if (!ctxMenu) return null;
    const w = 240;
    const h = ctxMenu.kind === "thread" ? 210 : 90;
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

      <div className="sidebarSection" role="region" aria-label="Threads">
        <div className="sectionTitleRow">
          <div className="sectionTitle" id="threads-label">Threads</div>
          <button
            className="iconButton threadsAddButton"
            type="button"
            onClick={() => void addWorkspace()}
            title="Add workspace"
            aria-label="Add workspace"
          >
            +
          </button>
        </div>

        <div className="workspaceList" role="list" aria-labelledby="threads-label">
          {workspaces.length === 0 ? (
            <div className="workspaceEmpty">
              <div className="workspaceEmptyTitle">No workspaces yet</div>
              <div className="workspaceEmptySub">Add a local folder to start a session.</div>
              <div className="workspaceEmptyActions">
                <button className="iconButton" type="button" onClick={() => void addWorkspace()}>
                  Add workspace
                </button>
                <button className="iconButton" type="button" onClick={() => openSettings("workspaces")}>
                  Open settings
                </button>
              </div>
            </div>
          ) : null}

          {workspaces.map((ws) => {
            const active = ws.id === selectedWorkspaceId;
            const rt = workspaceRuntimeById[ws.id];
            const serverPill =
              rt?.starting ? (
                <span className="pill">starting</span>
              ) : rt?.error ? (
                <span className="pill">error</span>
              ) : null;

            const workspaceSessions = active ? selectSidebarThreadsForWorkspace(threads, ws.id) : [];
            const sessionLimit = sessionLimitByWorkspaceId[ws.id] ?? 12;

            return (
              <Fragment key={ws.id}>
                <div
                  role="listitem"
                  className={"workspaceRow" + (active ? " workspaceRowActive" : "")}
                  onClick={() => void selectWorkspace(ws.id)}
                  tabIndex={0}
                  aria-current={active ? "true" : undefined}
                  title={ws.path}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void selectWorkspace(ws.id);
                    }
                  }}
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
                  <div className="workspaceRowTop">
                    <div className="workspaceRowLeft">
                      <span className="workspaceFolderIcon" aria-hidden="true" />
                      <div className="workspaceName">{ws.name}</div>
                    </div>
                    {serverPill}
                  </div>
                </div>

                {active ? (
                  <div className="workspaceSessions" role="group" aria-label={`Sessions in ${ws.name}`}>
                    {workspaceSessions.length === 0 ? (
                      <div className="workspaceSessionsEmpty">No sessions yet. Click New thread to start one.</div>
                    ) : (
                      <>
                        {workspaceSessions.slice(0, sessionLimit).map((t) => {
                          const tr = threadRuntimeById[t.id];
                          const busy = tr?.busy === true;
                          const isActive = t.id === selectedThreadId;
                          const age = formatRelativeAge(t.lastMessageAt);
                          const statusLabel = t.status === "active" ? null : "Transcript";
                          return (
                            <button
                              key={t.id}
                              className={"threadRow" + (isActive ? " threadRowActive" : "")}
                              type="button"
                              aria-current={isActive ? "true" : undefined}
                              onClick={() => {
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
                              <div className="threadRowMain">
                                <div className="threadTitleMain">{t.title || "New thread"}</div>
                              </div>

                              <div className="threadRowMeta">
                                {busy ? <span className="threadBusyDot" aria-hidden="true" title="Busy" /> : null}
                                {statusLabel ? <span className="threadStatusTag">{statusLabel}</span> : null}
                                {age ? <span className="threadAge">{age}</span> : null}
                              </div>
                            </button>
                          );
                        })}

                        {workspaceSessions.length > sessionLimit ? (
                          <button
                            className="sessionsShowMore"
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSessionLimitByWorkspaceId((s) => ({ ...s, [ws.id]: sessionLimit + 24 }));
                            }}
                          >
                            Show more
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </Fragment>
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

              {(() => {
                const t = threads.find((x) => x.id === ctxMenu.threadId);
                const rt = threadRuntimeById[ctxMenu.threadId];
                const canOpen = t?.status === "active";
                const canCheckpoint =
                  canOpen && rt?.sessionId && rt.busy !== true && rt?.backup?.status === "ready" && rt?.backupUi?.checkpointing !== true;

                if (!canOpen) return null;

                return (
                  <>
                    <button
                      className="ctxMenuItem"
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        openCheckpointsModal(ctxMenu.threadId);
                        setCtxMenu(null);
                      }}
                    >
                      Backups / checkpoints…
                    </button>

                    {canCheckpoint ? (
                      <button
                        className="ctxMenuItem"
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          checkpointThread(ctxMenu.threadId);
                          setCtxMenu(null);
                        }}
                      >
                        Checkpoint now
                      </button>
                    ) : null}
                  </>
                );
              })()}

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
