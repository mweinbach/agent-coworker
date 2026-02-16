import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemo } from "solid-js";
import { useTheme } from "../context/theme";
import { useSyncState } from "../context/sync";
import { Dialog } from "../ui/dialog";
import { useDialog } from "../context/dialog";

type SessionEntry = {
  id: string;
  updatedAtMs: number;
};

const SESSION_DIR = path.join(os.homedir(), ".cowork", "sessions");
const MAX_SESSION_ROWS = 100;

function loadSessionEntries(): SessionEntry[] {
  try {
    const files = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
    return files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .flatMap((entry) => {
        try {
          const fullPath = path.join(SESSION_DIR, entry.name);
          const stat = fs.statSync(fullPath);
          return [{
            id: entry.name.replace(/\.json$/, ""),
            updatedAtMs: stat.mtimeMs,
          }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, MAX_SESSION_ROWS);
  } catch {
    return [];
  }
}

function formatAge(updatedAtMs: number): string {
  const diffMs = Math.max(0, Date.now() - updatedAtMs);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function openSessionList(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <SessionListDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function SessionListDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();
  const syncState = useSyncState();
  const sessions = createMemo(() => loadSessionEntries());

  return (
    <Dialog onDismiss={props.onDismiss} width="60%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Sessions ({sessions().length})</strong>
        </text>

        <scrollbox maxHeight={14} marginBottom={1}>
          {sessions().length > 0 ? (
            <box flexDirection="column">
              {sessions().map((session) => (
                <box flexDirection="row" gap={1}>
                  <text fg={session.id === syncState.sessionId ? theme.accent : theme.textMuted}>
                    {session.id === syncState.sessionId ? "▸" : " "}
                  </text>
                  <text fg={theme.text}>{session.id}</text>
                  <text fg={theme.textMuted}>{formatAge(session.updatedAtMs)}</text>
                </box>
              ))}
            </box>
          ) : (
            <text fg={theme.textMuted}>No saved sessions found in ~/.cowork/sessions.</text>
          )}
        </scrollbox>

        <text fg={theme.textMuted}>
          Session resume is server-managed for now. Press Escape to close.
        </text>
      </box>
    </Dialog>
  );
}
