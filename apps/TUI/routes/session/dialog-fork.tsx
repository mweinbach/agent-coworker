import { useTheme } from "../../context/theme";
import { Dialog } from "../../ui/dialog";
import { useDialog } from "../../context/dialog";

export function openForkDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <ForkDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function ForkDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="50%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Fork Session</strong>
        </text>
        <text fg={theme.textMuted}>
          Session forking coming soon. This will allow branching from a specific message.
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
