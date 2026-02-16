import { useTheme } from "../context/theme";
import { Dialog } from "../ui/dialog";
import { useDialog } from "../context/dialog";

export function openSessionList(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <SessionListDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function SessionListDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="60%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Sessions</strong>
        </text>
        <text fg={theme.textMuted}>
          Session list coming soon. Session history is managed by the server.
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
