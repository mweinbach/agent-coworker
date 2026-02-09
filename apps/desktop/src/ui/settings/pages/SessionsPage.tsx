import { useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { formatThreadTime } from "../../../lib/time";

import { SettingsCard, SettingsPageHeader } from "../components";
import { selectArchivedThreadsSorted } from "../sessionSelectors";

export function SessionsPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);

  const unarchiveThread = useAppStore((s) => s.unarchiveThread);
  const removeThread = useAppStore((s) => s.removeThread);

  const archived = useMemo(() => selectArchivedThreadsSorted(threads), [threads]);

  return (
    <div className="settingsStack">
      <SettingsPageHeader
        title="Sessions"
        subtitle={
          <>
            Archived sessions are hidden from the main sidebar list. Unarchive to restore them as transcript-only sessions.
          </>
        }
      />

      <SettingsCard title="Archived sessions" subtitle={archived.length === 0 ? "No archived sessions yet." : undefined}>
        {archived.length === 0 ? (
          <div className="settingsEmpty">Right-click a session in the sidebar and choose Archive.</div>
        ) : (
          <div className="settingsSessionList">
            {archived.map((t) => {
              const wsName = workspaces.find((w) => w.id === t.workspaceId)?.name ?? "Unknown workspace";
              return (
                <div key={t.id} className="settingsSessionRow">
                  <div className="settingsSessionMain">
                    <div className="settingsSessionTitle">{t.title || "New thread"}</div>
                    <div className="settingsSessionMeta">
                      {wsName} · {formatThreadTime(t.lastMessageAt)}
                    </div>
                  </div>

                  <div className="settingsSessionActions">
                    <button className="iconButton" type="button" onClick={() => void unarchiveThread(t.id)}>
                      Unarchive
                    </button>
                    <button
                      className="iconButton settingsDangerButton"
                      type="button"
                      onClick={() => {
                        const ok = window.confirm(
                          `Remove session \"${t.title || "New thread"}\"? This will remove it from the app and delete its local transcript.`
                        );
                        if (!ok) return;
                        void removeThread(t.id);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

