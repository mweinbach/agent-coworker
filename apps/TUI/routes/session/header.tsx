import { createMemo } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncState } from "../../context/sync";

export function SessionHeader() {
  const theme = useTheme();
  const syncState = useSyncState();

  const title = createMemo(() => {
    if (syncState.sessionTitle?.trim()) return `# ${syncState.sessionTitle}`;
    return `# ${syncState.provider}/${syncState.model}`;
  });

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
      flexShrink={0}
      borderColor={theme.borderSubtle}
      border={["bottom"]}
    >
      <text fg={theme.text}>
        <strong>{title()}</strong>
      </text>
      <box flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>{syncState.cwd}</text>
      </box>
    </box>
  );
}
