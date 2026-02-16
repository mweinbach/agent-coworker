import { Show } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import type { ToolPartProps } from "../message/tool-part";

export function ReadTool(props: ToolPartProps) {
  const theme = useTheme();

  const filePath = () => props.args?.file_path ?? props.args?.path ?? "";

  return (
    <box flexDirection="row" gap={1} marginBottom={0}>
      <Show
        when={props.status === "done"}
        fallback={<Spinner color={theme.warning} />}
      >
        <text fg={theme.success}>✓</text>
      </Show>
      <text fg={theme.textMuted}>read</text>
      <text fg={theme.text}>{filePath()}</text>
    </box>
  );
}
