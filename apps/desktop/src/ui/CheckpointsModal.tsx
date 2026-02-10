import { useMemo } from "react";

import { useAppStore } from "../app/store";
import { formatThreadTime, safeDate } from "../lib/time";
import type { SessionBackupCheckpoint, SessionBackupPublicState } from "../app/types";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function sortCheckpointsDesc(checkpoints: SessionBackupCheckpoint[]): SessionBackupCheckpoint[] {
  const copy = [...checkpoints];
  copy.sort((a, b) => b.index - a.index);
  return copy;
}

function backupSummary(backup: SessionBackupPublicState | null): string {
  if (!backup) return "No backup state yet.";
  if (backup.status === "failed") {
    return backup.failureReason ?? "Backups are unavailable.";
  }
  if (backup.status === "initializing") return "Initializing backups (snapshotting workspace)…";
  const last = backup.checkpoints[backup.checkpoints.length - 1];
  if (!last) return "Ready. No checkpoints yet.";
  const lastTs = safeDate(last.createdAt);
  const when = lastTs ? formatThreadTime(last.createdAt) : last.createdAt;
  return `Ready. Last checkpoint: ${last.id} · ${when}`;
}

export function CheckpointsModal() {
  const threadId = useAppStore((s) => s.checkpointsModalThreadId);
  const close = useAppStore((s) => s.closeCheckpointsModal);
  const refresh = useAppStore((s) => s.refreshThreadBackups);
  const checkpointNow = useAppStore((s) => s.checkpointThread);
  const restore = useAppStore((s) => s.restoreThreadBackup);
  const deleteCheckpoint = useAppStore((s) => s.deleteThreadCheckpoint);

  const thread = useAppStore((s) => (threadId ? s.threads.find((t) => t.id === threadId) ?? null : null));
  const rt = useAppStore((s) => (threadId ? s.threadRuntimeById[threadId] ?? null : null));

  const backup = rt?.backup ?? null;
  const backupUi = rt?.backupUi ?? null;
  const busy = rt?.busy === true;
  const connected = rt?.connected === true;
  const sessionId = rt?.sessionId ?? null;

  const checkpoints = useMemo(() => sortCheckpointsDesc(backup?.checkpoints ?? []), [backup?.checkpoints]);

  if (!threadId) return null;

  const title = thread?.title || "Backups";
  const status = backup?.status ?? (connected ? "initializing" : "initializing");
  const error = backupUi?.error ?? null;

  const disableActions = !connected || !sessionId || busy || status !== "ready";
  const disableCheckpoint = disableActions || backupUi?.checkpointing === true || backupUi?.restoring === true;

  return (
    <div
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Backups and checkpoints"
      onMouseDown={close}
    >
      <div onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal">
          <div className="checkpointHeaderRow">
            <div className="modalTitle">Backups</div>
            <button className="modalButton" type="button" onClick={close}>
              Close
            </button>
          </div>

          <div className="checkpointTitle">{title}</div>

          <div className="checkpointStatus">
            <span className="checkpointStatusLabel">Status</span>
            <span className="checkpointStatusValue">{status}</span>
          </div>

          {error ? <div className="checkpointError">{error}</div> : null}

          <div className="modalBody">{backupSummary(backup)}</div>

          <div className="checkpointToolbar">
            <button
              className="modalButton"
              type="button"
              onClick={() => refresh(threadId)}
              disabled={!connected || backupUi?.refreshing === true}
              title={!connected ? "Connect the session to refresh" : undefined}
            >
              Refresh
            </button>

            <button
              className="modalButton modalButtonPrimary"
              type="button"
              onClick={() => checkpointNow(threadId)}
              disabled={disableCheckpoint}
              title={busy ? "Wait for the agent to finish" : status !== "ready" ? "Backups must be ready first" : undefined}
            >
              {backupUi?.checkpointing ? "Checkpointing…" : "Checkpoint now"}
            </button>

            <button
              className="modalButton"
              type="button"
              onClick={() => {
                const ok = window.confirm(
                  "Restore the workspace to the original snapshot?\n\nThis will modify files on disk immediately."
                );
                if (!ok) return;
                restore(threadId);
              }}
              disabled={disableActions || backupUi?.restoring === true}
              title={status !== "ready" ? "Backups must be ready first" : undefined}
            >
              {backupUi?.restoring ? "Restoring…" : "Restore original"}
            </button>
          </div>

          <div className="checkpointList" role="list" aria-label="Checkpoints">
            {checkpoints.length === 0 ? (
              <div className="checkpointEmpty">No checkpoints yet. Create one manually, or run a turn to generate automatic checkpoints.</div>
            ) : (
              checkpoints.map((cp) => {
                const deleting = backupUi?.deletingById?.[cp.id] === true;
                const createdAt = safeDate(cp.createdAt) ? formatThreadTime(cp.createdAt) : cp.createdAt;
                return (
                  <div key={cp.id} className="checkpointRow" role="listitem">
                    <div className="checkpointRowMain">
                      <div className="checkpointRowTitle">{cp.id}</div>
                      <div className="checkpointRowMeta">
                        {createdAt} · {cp.trigger} · {cp.changed ? "changed" : "no-op"} · {formatBytes(cp.patchBytes)}
                      </div>
                    </div>

                    <div className="checkpointRowActions">
                      <button
                        className="modalButton modalButtonOutline"
                        type="button"
                        onClick={() => {
                          const ok = window.confirm(
                            `Restore workspace to ${cp.id}?\n\nThis will modify files on disk immediately.`
                          );
                          if (!ok) return;
                          restore(threadId, cp.id);
                        }}
                        disabled={disableActions || deleting || backupUi?.restoring === true}
                      >
                        Restore
                      </button>

                      <button
                        className="modalButton modalButtonDanger"
                        type="button"
                        onClick={() => {
                          const ok = window.confirm(`Delete checkpoint ${cp.id}?`);
                          if (!ok) return;
                          deleteCheckpoint(threadId, cp.id);
                        }}
                        disabled={disableActions || deleting}
                        title={deleting ? "Deleting…" : undefined}
                      >
                        {deleting ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

