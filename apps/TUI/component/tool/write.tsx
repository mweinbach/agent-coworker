import { Show } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import type { ToolPartProps } from "../message/tool-part";

export function WriteTool(props: ToolPartProps) {
  const theme = useTheme();

  const filePath = () => props.args?.file_path ?? props.args?.path ?? "";

  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row" gap={1}>
        <Show
          when={props.status === "done"}
          fallback={<Spinner color={theme.warning} />}
        >
          <text fg={theme.success}>✓</text>
        </Show>
        <text fg={theme.textMuted}>write</text>
        <text fg={theme.text}>{filePath()}</text>
      </box>
    </box>
  );
}
