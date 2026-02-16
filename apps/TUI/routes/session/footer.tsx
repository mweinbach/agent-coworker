import { Show, createMemo } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncState } from "../../context/sync";

export function SessionFooter() {
  const theme = useTheme();
  const syncState = useSyncState();

  const statusColor = createMemo(() => {
    switch (syncState.status) {
      case "connected":
        return theme.success;
      case "connecting":
        return theme.warning;
      case "disconnected":
        return theme.error;
    }
  });

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      flexShrink={0}
    >
      <text fg={theme.textMuted}>{syncState.cwd || process.cwd()}</text>
      <box flexDirection="row" gap={2}>
        <text fg={statusColor()}>
          ● {syncState.status}
        </text>
        <Show when={syncState.busy}>
          <text fg={theme.warning}>working...</text>
        </Show>
      </box>
    </box>
  );
}
