import { Show } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import type { ToolPartProps } from "../message/tool-part";

export function WebTool(props: ToolPartProps) {
  const theme = useTheme();

  const isSearch = () => props.name === "webSearch";
  const query = () => {
    if (isSearch()) return props.args?.query ?? "";
    return props.args?.url ?? "";
  };

  return (
    <box flexDirection="row" gap={1} marginBottom={0}>
      <Show
        when={props.status === "done"}
        fallback={<Spinner color={theme.warning} />}
      >
        <text fg={theme.success}>✓</text>
      </Show>
      <text fg={theme.textMuted}>{isSearch() ? "search" : "fetch"}</text>
      <text fg={theme.text}>{query()}</text>
    </box>
  );
}
