import { useTheme } from "../context/theme";
import { Dialog } from "../ui/dialog";
import { useDialog } from "../context/dialog";

export function openSessionRename(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <SessionRenameDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function SessionRenameDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="50%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Rename Session</strong>
        </text>
        <text fg={theme.textMuted}>
          Session renaming coming soon.
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
