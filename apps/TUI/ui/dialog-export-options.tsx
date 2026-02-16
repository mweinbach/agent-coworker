import { useTheme } from "../context/theme";
import { Dialog } from "./dialog";
import { useDialog } from "../context/dialog";

export function openExportDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <ExportDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function ExportDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="50%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Export Options</strong>
        </text>
        <text fg={theme.textMuted}>
          Export configuration coming soon. This will allow exporting conversations in various formats.
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
