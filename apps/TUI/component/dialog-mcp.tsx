import { For } from "solid-js";
import { useTheme } from "../context/theme";
import { useSyncActions, useSyncState } from "../context/sync";
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
  const syncState = useSyncState();
  const syncActions = useSyncActions();

  return (
    <Dialog onDismiss={props.onDismiss} width="60%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>MCP Servers</strong>
        </text>

        <box flexDirection="row" gap={1} marginBottom={1}>
          <text fg={theme.textMuted}>MCP enabled:</text>
          <text fg={syncState.enableMcp ? theme.success : theme.warning}>
            {syncState.enableMcp ? "yes" : "no"}
          </text>
        </box>

        <box flexDirection="row" gap={1} marginBottom={1}>
          <box
            border
            borderStyle="single"
            borderColor={theme.border}
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={() => syncActions.setEnableMcp(!syncState.enableMcp)}
          >
            <text fg={theme.text}>
              {syncState.enableMcp ? "Disable MCP" : "Enable MCP"}
            </text>
          </box>
          <box
            border
            borderStyle="single"
            borderColor={theme.border}
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={() => syncActions.refreshTools()}
          >
            <text fg={theme.text}>Refresh tools</text>
          </box>
        </box>

        <text fg={theme.text} marginBottom={1}>
          <strong>Discovered Tools ({syncState.tools.length})</strong>
        </text>

        <scrollbox maxHeight={12} marginBottom={1}>
          {syncState.tools.length > 0 ? (
            <box flexDirection="column">
              <For each={syncState.tools}>
                {(tool) => (
                  <text fg={theme.textMuted}>{tool}</text>
                )}
              </For>
            </box>
          ) : (
            <text fg={theme.textMuted}>No tools discovered yet. Try Refresh tools.</text>
          )}
        </scrollbox>

        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
