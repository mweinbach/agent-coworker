import { useTheme } from "../context/theme";
import { useSyncState } from "../context/sync";
import { Dialog } from "../ui/dialog";
import { useDialog } from "../context/dialog";

export function openStatusDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <StatusDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function StatusDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();
  const syncState = useSyncState();

  return (
    <Dialog onDismiss={props.onDismiss} width="50%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>System Status</strong>
        </text>

        <box flexDirection="column" gap={0} paddingLeft={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} width={18}>Connection:</text>
            <text fg={syncState.status === "connected" ? theme.success : theme.error}>
              {syncState.status}
            </text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} width={18}>Session:</text>
            <text fg={theme.text}>{syncState.sessionId ?? "none"}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} width={18}>Provider:</text>
            <text fg={theme.text}>{syncState.provider || "none"}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} width={18}>Model:</text>
            <text fg={theme.text}>{syncState.model || "none"}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} width={18}>Working Directory:</text>
            <text fg={theme.text}>{syncState.cwd || process.cwd()}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} width={18}>Busy:</text>
            <text fg={syncState.busy ? theme.warning : theme.success}>
              {syncState.busy ? "yes" : "no"}
            </text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} width={18}>Feed Items:</text>
            <text fg={theme.text}>{syncState.feed.length}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} width={18}>Active Todos:</text>
            <text fg={theme.text}>
              {syncState.todos.filter((t) => t.status !== "completed").length}
            </text>
          </box>
        </box>

        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
