import { useTheme } from "../context/theme";
import { Dialog } from "../ui/dialog";
import { useDialog } from "../context/dialog";

export function openMcpDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <McpDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function McpDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="60%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>MCP Servers</strong>
        </text>
        <text fg={theme.textMuted}>
          MCP server management coming soon. Configure MCP servers in your config files.
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
