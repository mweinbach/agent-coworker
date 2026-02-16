import { useTheme } from "../../context/theme";
import { Dialog } from "../../ui/dialog";
import { useDialog } from "../../context/dialog";

export function openSubagentDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <SubagentDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function SubagentDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="50%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Sub-agents</strong>
        </text>
        <text fg={theme.textMuted}>
          Sub-agent viewer coming soon. This will show active sub-agent tasks and their status.
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
