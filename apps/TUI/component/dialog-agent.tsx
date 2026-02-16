import { useTheme } from "../context/theme";
import { Dialog } from "../ui/dialog";
import { useDialog } from "../context/dialog";

export function openAgentPicker(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <AgentPickerDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function AgentPickerDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="50%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Agent Picker</strong>
        </text>
        <text fg={theme.textMuted}>
          Multi-agent support coming soon. Custom agents will be configurable here.
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
