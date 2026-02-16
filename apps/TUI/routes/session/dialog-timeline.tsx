import { useTheme } from "../../context/theme";
import { Dialog } from "../../ui/dialog";
import { useDialog } from "../../context/dialog";

export function openTimeline(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <TimelineDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function TimelineDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="60%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Message Timeline</strong>
        </text>
        <text fg={theme.textMuted}>
          Timeline navigation coming soon. This will allow jumping to specific messages in the conversation.
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
