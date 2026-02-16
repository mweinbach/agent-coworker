import { Show, For } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import { TodoItem } from "../todo-item";
import type { ToolPartProps } from "../message/tool-part";
import type { TodoItem as TodoItemType } from "../../../src/types";

export function TodoTool(props: ToolPartProps) {
  const theme = useTheme();

  const todos = (): TodoItemType[] => {
    const r = props.args?.todos ?? props.result?.todos ?? [];
    if (Array.isArray(r)) return r;
    return [];
  };

  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row" gap={1}>
        <Show
          when={props.status === "done"}
          fallback={<Spinner color={theme.warning} />}
        >
          <text fg={theme.success}>✓</text>
        </Show>
        <text fg={theme.textMuted}>todos</text>
        <text fg={theme.text}>{todos().length} items</text>
      </box>
    </box>
  );
}
